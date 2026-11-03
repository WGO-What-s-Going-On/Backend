import { Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(DurableStreamConsumer.name);
  private stopped = false;
  private running?: Promise<void>;
  private cursor = '0-0';
  constructor(
    readonly database: PostgresDatabase,
    readonly options: {
      stream: string;
      group: string;
      dead: string;
      url: string;
      startId?: string;
      pendingIdleMs?: number;
      blockMs?: number;
    },
    readonly handle: (fields: Record<string, string>) => Promise<void>,
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
          : (await this.redis.xInfoStream(this.options.stream))[
              'last-generated-id'
            ];
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
  async process(entry: StreamEntry) {
    try {
      await this.handle(entry.message);
    } catch (e) {
      if (e instanceof BusyDeliveryError) return;
      const pending = await this.redis.xPendingRange(
        this.options.stream,
        this.options.group,
        entry.id,
        entry.id,
        1,
      );
      const invalid = e instanceof Error && e.message.startsWith('Invalid');
      if (!invalid && (pending[0]?.deliveriesCounter ?? 1) < 5) return;
      // Quarantine and ACK share one Redis operation. No crash can ACK before DLQ persistence.
      await this.redis.eval(
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
      return;
    }
    // Repeated ACK outages must not quarantine a committed event.
    await this.redis.xAck(this.options.stream, this.options.group, entry.id);
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
          this.logger.warn(`Input pending for ${this.options.stream}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }
}
