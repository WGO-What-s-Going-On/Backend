import { Logger } from '@nestjs/common';
import type { EmbeddingProvider } from './ports.js';
import { DIMENSIONS, validateEmbedding, type Embedding } from './policy.js';
import { E5_VERSION, modelPath } from './model-artifacts.js';
import { loadE5Runtime, type E5Runtime } from './e5-runtime.js';

type Job = {
  text: string;
  priority: 'interactive' | 'background';
  signal: AbortSignal;
  resolve(value: Embedding): void;
  reject(error: unknown): void;
  detach(): void;
};

export class E5EmbeddingProvider implements EmbeddingProvider {
  readonly version = E5_VERSION;
  private readonly logger = new Logger(E5EmbeddingProvider.name);
  private runtime: E5Runtime | undefined;
  private initialization?: Promise<void>;
  private running: Promise<void> | undefined;
  private closing?: Promise<void>;
  private readonly stop = new AbortController();
  private readonly queue: Job[] = [];
  private interactiveRuns = 0;
  private warmed = false;

  constructor(
    private readonly enabled = true,
    private readonly load: () => Promise<E5Runtime> = () =>
      loadE5Runtime(modelPath()),
    private readonly maxQueue = 16,
    private readonly timeoutMs = 10000,
  ) {
    if (
      !Number.isInteger(maxQueue) ||
      maxQueue < 1 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1
    )
      throw new Error('Invalid embedding queue configuration');
  }

  get ready() {
    return this.warmed && !this.stop.signal.aborted;
  }

  onModuleInit() {
    // 모델 준비 실패가 기존 생성·조회와 생존 확인을 막지 않게 한다.
    void this.initialize().catch((error: unknown) =>
      this.logger.warn(`Embedding unavailable: ${String(error)}`),
    );
  }

  initialize(): Promise<void> {
    return (this.initialization ??= this.loadAndWarm());
  }

  private async loadAndWarm() {
    if (!this.enabled) return;
    this.stop.signal.throwIfAborted();
    try {
      this.runtime = await this.load();
      await this.calculate('모델 준비 확인', this.stop.signal);
      this.stop.signal.throwIfAborted();
      this.warmed = true;
      this.logger.log(`Embedding ready: ${this.version}`);
    } catch (error) {
      await this.runtime?.close();
      this.runtime = undefined;
      throw error;
    }
  }

  async embed(
    text: string,
    signal: AbortSignal,
    priority: Job['priority'] = 'interactive',
  ): Promise<Embedding> {
    if (!this.ready) throw new Error('Embedding model is not ready');
    const deadline = AbortSignal.any([
      signal,
      this.stop.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    deadline.throwIfAborted();
    if (this.queue.length >= this.maxQueue)
      throw new Error('Embedding queue is full');
    return new Promise<Embedding>((resolve, reject) => {
      const abort = () => {
        const position = this.queue.indexOf(job);
        if (position >= 0) this.queue.splice(position, 1);
        job.detach();
        reject(deadline.reason);
      };
      const job: Job = {
        text,
        signal: deadline,
        priority,
        resolve,
        reject,
        detach: () => deadline.removeEventListener('abort', abort),
      };
      deadline.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    if (this.running || !this.ready || !this.queue.length) return;
    // 요청을 우선하되 연속 3건 뒤에는 대기 중인 인덱싱에 차례를 준다.
    const preferred = this.interactiveRuns >= 3 ? 'background' : 'interactive';
    const position = this.queue.findIndex((job) => job.priority === preferred);
    const job = this.queue.splice(Math.max(0, position), 1)[0]!;
    this.interactiveRuns =
      job.priority === 'interactive' ? this.interactiveRuns + 1 : 0;
    job.detach();
    // AbortSignal이 네이티브 ONNX 계산을 즉시 멈추지는 않는다. 실제 종료까지 슬롯을 유지한다.
    this.running = this.calculate(job.text, job.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = undefined;
        this.pump();
      });
  }

  private async calculate(
    text: string,
    signal: AbortSignal,
  ): Promise<Embedding> {
    signal.throwIfAborted();
    const runtime = this.runtime!;
    const tokens = runtime.tokenize(text);
    if (!tokens.length) throw new Error('Empty embedding input');
    const width = 480 - runtime.prefix.length - runtime.suffix.length;
    if (width <= 64) throw new Error('Invalid E5 token window');
    const sum = Array<number>(DIMENSIONS).fill(0);
    // 원문 토큰을 직접 잘라 재토큰화 손실 없이 끝부분까지 포함한다.
    for (let offset = 0; offset < tokens.length; offset += width - 64) {
      signal.throwIfAborted();
      const vector = await runtime.infer([
        ...runtime.prefix,
        ...tokens.slice(offset, offset + width),
        ...runtime.suffix,
      ]);
      signal.throwIfAborted();
      validateEmbedding({ vector, version: this.version }, this.version);
      const norm = Math.hypot(...vector);
      vector.forEach((value, i) => {
        sum[i] = sum[i]! + value / norm;
      });
      if (offset + width >= tokens.length) break;
    }
    const norm = Math.hypot(...sum);
    const result = {
      vector: sum.map((value) => value / norm),
      version: this.version,
    };
    validateEmbedding(result, this.version);
    return result;
  }

  close(): Promise<void> {
    return (this.closing ??= this.dispose());
  }

  private async dispose() {
    this.stop.abort(new Error('Embedding provider closed'));
    await this.initialization?.catch(() => {});
    await this.running;
    await this.runtime?.close();
    this.runtime = undefined;
  }

  // Worker의 onModuleDestroy가 진행 중인 저장/ACK를 마친 뒤 모델을 해제한다.
  async onApplicationShutdown() {
    await this.close();
  }
}

export function createEmbeddingProvider() {
  return new E5EmbeddingProvider(
    process.env.SEMANTIC_ENABLED !== 'false' &&
      process.env.SEMANTIC_MODEL_ENABLED !== 'false',
  );
}
