import { afterEach, describe, expect, it, vi } from 'vitest';
import { E5EmbeddingProvider } from '../src/post/semantic/embedding-provider.js';
import type { E5Runtime } from '../src/post/semantic/e5-runtime.js';
import {
  SemanticWorker,
  SemanticConsumer,
} from '../src/post/semantic/worker.js';
import { IndexSemanticPost } from '../src/post/semantic/index-post.js';
import { fixtureEmbedding } from './fixtures/semantic.js';

const vector = [1, ...Array<number>(383).fill(0)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function runtime(): E5Runtime {
  return {
    prefix: [0, 11, 12],
    suffix: [2],
    tokenize: (text) => [...text].map((_, i) => 100 + i),
    infer: vi.fn(async () => [...vector]),
    close: vi.fn(async () => {}),
  };
}
const providers: E5EmbeddingProvider[] = [];
function provider(model: E5Runtime, limit = 16, timeout = 10000) {
  const load = vi.fn(async () => model);
  const value = new E5EmbeddingProvider(true, load, limit, timeout);
  providers.push(value);
  return { value, load };
}
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const value of providers.splice(0)) await value.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('E5 lifecycle and bounded inference', () => {
  it('loads and warms only once and disposes once', async () => {
    const model = runtime();
    const { value, load } = provider(model);
    expect(value.ready).toBe(false);
    await Promise.all([value.initialize(), value.initialize()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(model.infer).toHaveBeenCalledTimes(1);
    expect(value.ready).toBe(true);
    await value.close();
    await value.close();
    expect(model.close).toHaveBeenCalledTimes(1);
    await expect(value.embed('closed', signal())).rejects.toThrow('not ready');
  });

  it('keeps startup alive when loading fails or the model is disabled', async () => {
    const load = vi.fn(async (): Promise<E5Runtime> => {
      throw new Error('missing files');
    });
    const absent = new E5EmbeddingProvider(true, load);
    providers.push(absent);
    expect(() => absent.onModuleInit()).not.toThrow();
    await expect(absent.initialize()).rejects.toThrow('missing files');
    expect(absent.ready).toBe(false);
    const disabled = new E5EmbeddingProvider(false, load);
    providers.push(disabled);
    await disabled.initialize();
    expect(disabled.ready).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('includes all long-text tokens with a 64-token overlap and normalizes pooled windows', async () => {
    const model = runtime();
    const { value } = provider(model);
    await value.initialize();
    vi.mocked(model.infer).mockClear();
    const result = await value.embed('가'.repeat(1000), signal());
    const windows = vi.mocked(model.infer).mock.calls.map(([tokens]) => tokens);
    expect(windows).toHaveLength(3);
    expect(windows.every((tokens) => tokens.length <= 480)).toBe(true);
    const bodies = windows.map((tokens) => tokens.slice(3, -1));
    expect(bodies[0]!.slice(-64)).toEqual(bodies[1]!.slice(0, 64));
    expect(new Set(bodies.flat()).size).toBe(1000);
    expect(bodies.at(-1)!.at(-1)).toBe(1099);
    expect(result.vector).toEqual(vector);
  });

  it('rejects invalid model output and never marks a failed warmup ready', async () => {
    const model = runtime();
    vi.mocked(model.infer).mockResolvedValue(Array<number>(384).fill(0));
    const { value } = provider(model);
    await expect(value.initialize()).rejects.toThrow('Invalid embedding');
    expect(value.ready).toBe(false);
    expect(model.close).toHaveBeenCalledTimes(1);
  });

  it('removes cancelled queued work and holds the slot until cancelled native work finishes', async () => {
    const model = runtime();
    const { value } = provider(model, 1);
    await value.initialize();
    vi.mocked(model.infer).mockClear();
    const native = deferred<number[]>();
    vi.mocked(model.infer).mockImplementationOnce(() => native.promise);
    const active = new AbortController();
    const queued = new AbortController();
    const first = value.embed('first', active.signal);
    const firstRejected = expect(first).rejects.toThrow('cancel running');
    const second = value.embed('second', queued.signal);
    const secondRejected = expect(second).rejects.toThrow('cancel queued');
    await expect(value.embed('overflow', signal())).rejects.toThrow(
      'queue is full',
    );
    queued.abort(new Error('cancel queued'));
    await secondRejected;
    const third = value.embed('third', signal());
    active.abort(new Error('cancel running'));
    await Promise.resolve();
    expect(model.infer).toHaveBeenCalledTimes(1);
    native.resolve(vector);
    await firstRejected;
    await third;
    expect(model.infer).toHaveBeenCalledTimes(2);
  });

  it('bounds queue wait and drains native work before shutdown', async () => {
    const model = runtime();
    const { value } = provider(model, 1, 20);
    await value.initialize();
    const native = deferred<number[]>();
    vi.mocked(model.infer).mockImplementationOnce(() => native.promise);
    const active = value.embed('first', signal());
    const activeRejected = expect(active).rejects.toThrow();
    const waiting = value.embed('second', signal());
    await expect(waiting).rejects.toThrow();
    const closed = value.close();
    expect(model.close).not.toHaveBeenCalled();
    native.resolve(vector);
    await activeRejected;
    await closed;
    expect(model.close).toHaveBeenCalledTimes(1);
  });

  it('gives background indexing a turn after three interactive jobs', async () => {
    const model = runtime();
    model.tokenize = (text) => [Number(text) || 1];
    const { value } = provider(model);
    await value.initialize();
    vi.mocked(model.infer).mockClear();
    const native = deferred<number[]>();
    vi.mocked(model.infer).mockImplementationOnce(() => native.promise);
    const jobs = [value.embed('1', signal())];
    jobs.push(value.embed('99', signal(), 'background'));
    for (let i = 2; i <= 5; i++) jobs.push(value.embed(String(i), signal()));
    native.resolve(vector);
    await Promise.all(jobs);
    expect(
      vi.mocked(model.infer).mock.calls.map(([tokens]) => tokens[3]),
    ).toEqual([1, 2, 3, 99, 4, 5]);
  });

  it('waits for model readiness before connecting the worker and honors shutdown during load', async () => {
    vi.stubEnv('SEMANTIC_ENABLED', 'true');
    vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'true');
    const initialized = deferred<void>();
    const embedding = {
      ...fixtureEmbedding(),
      ready: false,
      initialize: () => initialized.promise,
    };
    const worker = new SemanticWorker(embedding, {} as IndexSemanticPost);
    const connect = vi.spyOn(worker.redis, 'connect');
    worker.onModuleInit();
    expect(connect).not.toHaveBeenCalled();
    const closed = worker.onModuleDestroy();
    embedding.ready = true;
    initialized.resolve();
    await closed;
    expect(connect).not.toHaveBeenCalled();
  });

  it('starts consumption when asynchronous initialization becomes ready', async () => {
    vi.stubEnv('SEMANTIC_ENABLED', 'true');
    vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'true');
    const initialized = deferred<void>();
    const embedding = {
      ...fixtureEmbedding(),
      ready: false,
      initialize: () => initialized.promise,
    };
    const worker = new SemanticWorker(embedding, {
      embedding,
    } as IndexSemanticPost);
    const connect = vi
      .spyOn(worker.redis, 'connect')
      .mockResolvedValue(worker.redis);
    vi.spyOn(SemanticConsumer.prototype, 'initialize').mockResolvedValue();
    const tick = vi
      .spyOn(SemanticConsumer.prototype, 'tick')
      .mockResolvedValue();
    worker.onModuleInit();
    expect(connect).not.toHaveBeenCalled();
    embedding.ready = true;
    initialized.resolve();
    try {
      await vi.waitFor(() => expect(tick).toHaveBeenCalled());
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await worker.onModuleDestroy();
    }
  });
});
