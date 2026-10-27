import type { Model } from 'mongoose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { redis } = vi.hoisted(() => ({
  redis: {
    isOpen: false,
    on: vi.fn(),
    connect: vi.fn(),
    xAdd: vi.fn(),
    destroy: vi.fn(),
    quit: vi.fn(),
  },
}));
vi.mock('redis', () => ({ createClient: () => redis }));
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';

const sample = () => ({
  _id: 'row',
  eventId: 'evt_11111111-1111-4111-8111-111111111111',
  aggregateId: 'post_22222222-2222-4222-8222-222222222222',
  eventType: 'PostReactionCreated',
  schemaVersion: 1,
  producer: 'post-service',
  correlationId: 'req_test',
  occurredAt: new Date(),
  createdAt: new Date(),
  attemptCount: 1,
  payload: {
    reaction: {
      postId: 'post_22222222-2222-4222-8222-222222222222',
      userId: 123,
      type: 'LIKE',
      createdAt: new Date(),
    },
  },
});
function model(row: ReturnType<typeof sample>) {
  const next = vi.fn().mockResolvedValueOnce(row).mockResolvedValue(null);
  return {
    findOneAndUpdate: vi.fn(() => ({ lean: next })),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  redis.isOpen = false;
  redis.connect.mockImplementation(async () => {
    redis.isOpen = true;
  });
  redis.xAdd.mockResolvedValue('123-0');
  redis.destroy.mockImplementation(() => {
    redis.isOpen = false;
  });
  redis.quit.mockImplementation(async () => {
    redis.isOpen = false;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('backs off Redis failures and preserves the event identity', async () => {
  const row = sample();
  const db = model(row);
  redis.xAdd.mockRejectedValueOnce(new Error('connection lost'));
  const worker = new OutboxWorker(db as unknown as Model<any>);
  await worker.publishPending();
  expect(db.updateOne.mock.calls[0]?.[1].$set).toMatchObject({
    status: 'PENDING',
    lastError: expect.stringContaining('connection lost'),
    claimedBy: null,
  });
  expect(
    db.updateOne.mock.calls[0]?.[1].$set.nextAttemptAt.getTime(),
  ).toBeGreaterThan(Date.now());
  expect(redis.xAdd.mock.calls[0]?.[2].eventId).toBe(row.eventId);
  await worker.onModuleDestroy();
});

it('quarantines exhausted retries and malformed events without blocking subsequent polling', async () => {
  vi.stubEnv('OUTBOX_MAX_ATTEMPTS', '2');
  const row = { ...sample(), attemptCount: 2 };
  const db = model(row);
  redis.xAdd.mockRejectedValueOnce(new Error('offline'));
  const worker = new OutboxWorker(db as unknown as Model<any>);
  await worker.publishPending();
  expect(db.updateOne.mock.calls[0]?.[1].$set).toMatchObject({
    status: 'FAILED',
    failedAt: expect.any(Date),
  });
  await worker.onModuleDestroy();
  const invalid = model({
    ...sample(),
    payload: { ...sample().payload, eventId: 'overwrite' },
  } as ReturnType<typeof sample>);
  const badWorker = new OutboxWorker(invalid as unknown as Model<any>);
  redis.xAdd.mockClear();
  await badWorker.publishPending();
  expect(redis.xAdd).not.toHaveBeenCalled();
  expect(invalid.updateOne.mock.calls[0]?.[1].$set.status).toBe('FAILED');
  await badWorker.onModuleDestroy();
});

it('retries an ambiguous publish after the PUBLISHED database update fails', async () => {
  const row = sample();
  const db = model(row);
  db.updateOne.mockRejectedValueOnce(new Error('database unavailable'));
  const worker = new OutboxWorker(db as unknown as Model<any>);
  await worker.publishPending();
  expect(db.updateOne.mock.calls[0]?.[1].$set.status).toBe('PUBLISHED');
  expect(db.updateOne.mock.calls[1]?.[1].$set.status).toBe('PENDING');
  expect(db.updateOne.mock.calls[0]?.[0]).toMatchObject({
    status: 'PUBLISHING',
    claimedBy: expect.any(String),
  });
  expect(db.updateOne.mock.calls[1]?.[0]).toEqual(
    db.updateOne.mock.calls[0]?.[0],
  );
  await worker.onModuleDestroy();
});

it('bounds Redis I/O and destroys the timed-out connection before retry', async () => {
  vi.useFakeTimers();
  vi.stubEnv('OUTBOX_REDIS_TIMEOUT_MS', '50');
  redis.xAdd.mockImplementationOnce(() => new Promise(() => {}));
  const db = model(sample());
  const worker = new OutboxWorker(db as unknown as Model<any>);
  const work = worker.publishPending();
  await vi.advanceTimersByTimeAsync(60);
  await work;
  expect(redis.destroy).toHaveBeenCalled();
  expect(db.updateOne.mock.calls[0]?.[1].$set.status).toBe('PENDING');
  await worker.onModuleDestroy();
});

it('leaves a failed database recovery to the expiring lease and uses a new claim token next time', async () => {
  const row = sample();
  const db = model(row);
  redis.xAdd.mockRejectedValueOnce(new Error('Redis unavailable'));
  db.updateOne.mockRejectedValueOnce(new Error('MongoDB unavailable'));
  const worker = new OutboxWorker(db as unknown as Model<any>);
  await expect(worker.publishPending()).rejects.toThrow('MongoDB unavailable');
  const firstClaim = db.findOneAndUpdate.mock.calls[0] as unknown as [
    unknown,
    { $set: { claimedBy: string } },
  ];
  db.findOneAndUpdate.mockImplementationOnce(() => ({
    lean: vi.fn().mockResolvedValue({ ...row, attemptCount: 2 }),
  }));
  await worker.publishPending();
  const nextClaim = db.findOneAndUpdate.mock.calls[1] as unknown as [
    unknown,
    { $set: { claimedBy: string } },
  ];
  expect(nextClaim[1].$set.claimedBy).not.toBe(firstClaim[1].$set.claimedBy);
  expect(db.updateOne.mock.calls[1]?.[0].claimedBy).toBe(
    nextClaim[1].$set.claimedBy,
  );
  await worker.onModuleDestroy();
});

it('quarantines a reclaimed final attempt without another XADD', async () => {
  vi.stubEnv('OUTBOX_MAX_ATTEMPTS', '2');
  const db = model({ ...sample(), attemptCount: 3 });
  const worker = new OutboxWorker(db as unknown as Model<any>);
  await worker.publishPending();
  expect(redis.xAdd).not.toHaveBeenCalled();
  expect(db.updateOne.mock.calls[0]?.[1].$set.status).toBe('FAILED');
  await worker.onModuleDestroy();
});
