import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './ports.js';
import {
  IndexSemanticPost,
  InvalidSemanticEvent,
  semanticEvent,
} from './index-post.js';

export const SEMANTIC_STREAM = 'post:events';
export type StreamEntry = { id: string; message: Record<string, string> };
export type SemanticRedis = ReturnType<typeof createClient>;
export function semanticRedis() {
  return createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6380',
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });
}
export function group(version: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(version))
    throw new Error('Invalid embedding version');
  return `post-semantic-${version}`;
}

// Worker와 재구축은 같은 버전의 lease를 공유한다. 소유권을 잃으면 쓰기 전에 중단한다.
export async function withSemanticLease<T>(
  redis: SemanticRedis,
  version: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T } | null> {
  const key = `${group(version)}:lease`;
  const token = randomUUID();
  if (!(await redis.set(key, token, { NX: true, PX: 60000 }))) return null;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void redis
      .eval(
        "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],60000) else return 0 end",
        { keys: [key], arguments: [token] },
      )
      .then((ok) => {
        if (!ok) controller.abort(new Error('Semantic lease lost'));
      })
      .catch((error) => controller.abort(error));
  }, 10000);
  heartbeat.unref();
  try {
    return { value: await work(controller.signal) };
  } finally {
    clearInterval(heartbeat);
    await redis.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      { keys: [key], arguments: [token] },
    );
  }
}

export class SemanticConsumer {
  readonly name = `semantic-${randomUUID()}`;
  readonly group: string;
  readonly deadStream: string;
  private claimCursor = '0-0';
  constructor(
    readonly redis: SemanticRedis,
    readonly indexing: IndexSemanticPost,
    readonly reclaimMs = 30000,
  ) {
    if (reclaimMs <= 10000)
      throw new Error('Reclaim grace must exceed the 10s job timeout');
    this.group = group(indexing.embedding.version);
    this.deadStream = `${this.group}:dead`;
  }
  async initialize() {
    try {
      await this.redis.xGroupCreate(SEMANTIC_STREAM, this.group, '0', {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }
  async tick() {
    if (!this.indexing.embedding.ready) return;
    await withSemanticLease(
      this.redis,
      this.indexing.embedding.version,
      async (signal) => {
        const claimed = await this.redis.xAutoClaim(
          SEMANTIC_STREAM,
          this.group,
          this.name,
          this.reclaimMs,
          this.claimCursor,
          { COUNT: 1 },
        );
        this.claimCursor = claimed.nextId;
        for (const entry of claimed.messages)
          if (entry) await this.process(entry, signal);
        const batches = (await this.redis.xReadGroup(
          this.group,
          this.name,
          { key: SEMANTIC_STREAM, id: '>' },
          { COUNT: 1 },
        )) as Array<{ messages: StreamEntry[] }> | null;
        for (const batch of batches ?? [])
          for (const entry of batch.messages) await this.process(entry, signal);
      },
    );
  }
  async process(
    entry: StreamEntry,
    leaseSignal = new AbortController().signal,
  ) {
    const fields = entry.message;
    try {
      const id = semanticEvent(fields);
      if (id)
        await this.indexing.execute(
          id,
          AbortSignal.any([leaseSignal, AbortSignal.timeout(10000)]),
        );
      leaseSignal.throwIfAborted();
      await this.redis.xAck(SEMANTIC_STREAM, this.group, entry.id);
    } catch (error) {
      leaseSignal.throwIfAborted();
      const pending = await this.redis.xPendingRange(
        SEMANTIC_STREAM,
        this.group,
        entry.id,
        entry.id,
        1,
      );
      if (
        error instanceof InvalidSemanticEvent ||
        (pending[0]?.deliveriesCounter ?? 1) >= 5
      ) {
        // DLQ 기록이 실패하면 ACK하지 않아 다음 회수에서 다시 기록한다.
        await this.redis.xAdd(this.deadStream, '*', {
          streamId: entry.id,
          eventId: fields.eventId ?? '',
          error: String(error),
          data: fields.data ?? '',
        });
        await this.redis.xAck(SEMANTIC_STREAM, this.group, entry.id);
      }
    }
  }
}

@Injectable()
export class SemanticWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SemanticWorker.name);
  readonly redis = semanticRedis();
  private stopped = false;
  private running?: Promise<void>;
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    private readonly indexing: IndexSemanticPost,
  ) {
    this.redis.on('error', (error) => this.logger.warn(String(error)));
  }
  onModuleInit() {
    // 준비 전에는 Redis 연결·그룹 생성·배달 자체를 시작하지 않는다.
    if (
      process.env.SEMANTIC_ENABLED === 'false' ||
      process.env.SEMANTIC_WORKER_ENABLED === 'false'
    )
      return;
    if (!this.running && !this.stopped) this.running = this.startWhenReady();
  }
  private async startWhenReady() {
    try {
      await this.embedding.initialize?.();
      if (!this.stopped && this.embedding.ready) await this.run();
    } catch (error) {
      this.logger.warn(`Semantic worker not started: ${String(error)}`);
    }
  }
  private async run() {
    while (!this.stopped) {
      try {
        if (!this.redis.isOpen) await this.redis.connect();
        const consumer = new SemanticConsumer(this.redis, this.indexing);
        await consumer.initialize();
        while (!this.stopped) {
          await consumer.tick();
          await delay(250);
        }
      } catch (error) {
        this.logger.warn(`Semantic worker retry: ${String(error)}`);
        if (!this.stopped) await delay(1000);
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    await this.running;
    if (this.redis.isOpen) await this.redis.quit();
  }
}
