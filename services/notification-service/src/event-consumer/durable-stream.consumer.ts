import {
  createLogger,
  requestContext,
  withLogContext,
} from '../observability/logging.js';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { BusyDeliveryError } from '../persistence/postgres-event.store.js';

export interface StreamEntry {
  id: string;
  message: Record<string, string>;
}
export class DurableStreamConsumer {
  readonly redis: ReturnType<typeof createClient>;
  readonly consumer = `notification-${randomUUID()}`;
  private readonly logger = createLogger('notification-service', 'events');
  private stopped = false;
  private running?: Promise<void>;
  private cursor = '0-0';
  featureStartId: string | undefined;
  constructor(
    readonly database: PostgresDatabase,
    readonly options: {
      stream: string;
      group: string;
      dead: string;
      url: string;
      startId?: string;
      featureCutoffKey?: string;
      pendingIdleMs?: number;
      blockMs?: number;
    },
    readonly handle: (
      fields: Record<string, string>,
      streamId?: string,
    ) => Promise<void>,
    redis?: ReturnType<typeof createClient>,
  ) {
    this.redis =
      redis ??
      createClient({
        url: options.url,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: false, connectTimeout: 2000 },
      });
    this.redis.on('error', () => undefined);
  }
  isReady() {
    return !this.stopped && this.redis.isReady && this.running !== undefined;
  }
  async initialize() {
    if (this.redis.isOpen && !this.redis.isReady) await this.redis.disconnect();
    if (!this.redis.isOpen) await this.redis.connect();
    let last = '0-0';
    let generated = '0-0';
    try {
      generated = (await this.redis.xInfoStream(this.options.stream))[
        'last-generated-id'
      ];
    } catch (error) {
      if (!String(error).includes('no such key')) throw error;
    }
    if (this.options.startId !== undefined) {
      if (!/^\d+-\d+$/.test(this.options.startId))
        throw new Error('Invalid explicit stream replay start');
      last = this.options.startId;
    } else {
      try {
        const groups = await this.redis.xInfoGroups(this.options.stream);
        // Existing groups may have old PEL entries. Recreated groups replay
        // against durable receipts instead of skipping unfinished work.
        last = groups.some((group) => group.name === this.options.group)
          ? '0-0'
          : generated;
      } catch (e) {
        if (!String(e).includes('no such key')) throw e;
      }
    }
    await this.database.pool.query(
      `INSERT INTO notification_stream_starts VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [this.options.stream, this.options.group, last],
    );
    const checkpoint = (
      await this.database.pool.query(
        'SELECT start_id FROM notification_stream_starts WHERE source_stream=$1 AND consumer_group=$2',
        [this.options.stream, this.options.group],
      )
    ).rows[0];
    if (this.options.featureCutoffKey) {
      await this.database.pool.query(
        'INSERT INTO notification_stream_starts VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [this.options.stream, this.options.featureCutoffKey, generated],
      );
      this.featureStartId = (
        await this.database.pool.query(
          'SELECT start_id FROM notification_stream_starts WHERE source_stream=$1 AND consumer_group=$2',
          [this.options.stream, this.options.featureCutoffKey],
        )
      ).rows[0].start_id;
    }
    try {
      await this.redis.xGroupCreate(
        this.options.stream,
        this.options.group,
        checkpoint.start_id,
        { MKSTREAM: true },
      );
    } catch (e) {
      if (!String(e).includes('BUSYGROUP')) throw e;
    }
  }
  async onModuleInit() {
    await this.initialize();
    this.running = this.loop();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.redis.isOpen) await this.redis.disconnect();
    await this.running?.catch(() => undefined);
  }
  async process(entry: StreamEntry): Promise<void> {
    let correlationId: unknown;
    try {
      const envelope: unknown = JSON.parse(entry.message.data ?? '{}');
      if (
        envelope &&
        typeof envelope === 'object' &&
        'correlationId' in envelope
      )
        correlationId = envelope.correlationId;
    } catch {
      /* The domain parser below classifies malformed deliveries. */
    }
    return withLogContext(
      requestContext({
        'x-correlation-id': correlationId ?? entry.message.eventId,
      }),
      () => this.processEntry(entry),
    );
  }
  private async processEntry(entry: StreamEntry): Promise<void> {
    try {
      await this.handle(entry.message, entry.id);
      this.logger.success(
        'notification_event_processed',
        'Notification event processing completed',
        {
          stream: this.options.stream,
          streamId: entry.id,
          eventId: entry.message.eventId,
          consumerGroup: this.options.group,
        },
      );
    } catch (e) {
      if (e instanceof BusyDeliveryError) {
        this.logger.skipped('notification_event_busy', 'DELIVERY_BUSY', {
          streamId: entry.id,
          stream: this.options.stream,
        });
        return;
      }
      const pending = await this.redis.xPendingRange(
        this.options.stream,
        this.options.group,
        entry.id,
        entry.id,
        1,
      );
      const invalid = e instanceof Error && e.message.startsWith('Invalid');
      const retryable = !invalid && (pending[0]?.deliveriesCounter ?? 1) < 5;
      this.logger.failure(
        'notification_event_failed',
        e,
        invalid ? 'INVALID_EVENT' : 'EVENT_PROCESSING_FAILED',
        'Notification event processing failed',
        {
          stream: this.options.stream,
          streamId: entry.id,
          eventId: entry.message.eventId,
          attempt: pending[0]?.deliveriesCounter ?? 1,
        },
        retryable,
      );
      if (retryable) return;
      // Quarantine and ACK share one Redis operation. No crash can ACK before DLQ persistence.
      const moved = await this.redis.eval(
        `if #redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[2],ARGV[2],1)==0 then return 0 end
        redis.call('XADD',KEYS[2],'*','streamId',ARGV[2],'eventId',ARGV[3],'data',ARGV[4],'reason',ARGV[5]);
        return redis.call('XACK',KEYS[1],ARGV[1],ARGV[2])`,
        {
          keys: [this.options.stream, this.options.dead],
          arguments: [
            this.options.group,
            entry.id,
            entry.message.eventId ?? '',
            entry.message.data ?? '',
            invalid ? 'INVALID_EVENT' : 'RETRY_EXHAUSTED',
          ],
        },
      );
      if (Number(moved) > 0)
        this.logger.success(
          'notification_event_dead_lettered',
          'Notification event quarantined and acknowledged',
          {
            stream: this.options.dead,
            streamId: entry.id,
            eventId: entry.message.eventId,
          },
        );
      return;
    }
    // Repeated ACK outages must not quarantine a committed event.
    try {
      await this.redis.xAck(this.options.stream, this.options.group, entry.id);
    } catch (error) {
      this.logger.failure(
        'notification_ack_failed',
        error,
        'STREAM_ACK_FAILED',
        'Committed event acknowledgement failed; redelivery is safe',
        {
          stream: this.options.stream,
          streamId: entry.id,
          eventId: entry.message.eventId,
        },
        true,
      );
      throw error;
    }
    this.logger.success(
      'notification_event_acknowledged',
      'Notification delivery acknowledged',
      {
        stream: this.options.stream,
        streamId: entry.id,
        consumerGroup: this.options.group,
      },
    );
  }
  async pollOnce() {
    if (!this.redis.isReady) await this.initialize();
    const claimed = await this.redis.xAutoClaim(
      this.options.stream,
      this.options.group,
      this.consumer,
      this.options.pendingIdleMs ?? 30000,
      this.cursor,
      { COUNT: 20 },
    );
    this.cursor = claimed.nextId;
    for (const entry of claimed.messages)
      if (entry) await this.process(entry as StreamEntry);
    const batches = (await this.redis.xReadGroup(
      this.options.group,
      this.consumer,
      { key: this.options.stream, id: '>' },
      { COUNT: 20, BLOCK: this.options.blockMs ?? 1000 },
    )) as unknown as Array<{ messages: StreamEntry[] }> | null;
    for (const batch of batches ?? [])
      for (const entry of batch.messages)
        await this.process(entry as StreamEntry);
  }
  private async loop() {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.stopped) {
          if (String(error).includes('NOGROUP'))
            await this.initialize().catch(() => undefined);
          this.logger.failure(
            'notification_poll_failed',
            error,
            'STREAM_POLL_FAILED',
            'Notification stream polling failed',
            { stream: this.options.stream },
            true,
          );
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }
}
