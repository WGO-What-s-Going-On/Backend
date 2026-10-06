import type { Model } from 'mongoose';
import { setImmediate as immediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';

it('drains an in-flight outbox query before shutdown and ignores later wakeups', async () => {
  let finish!: (value: null) => void;
  const query = new Promise<null>((resolve) => {
    finish = resolve;
  });
  const model = { findOneAndUpdate: vi.fn(() => ({ lean: () => query })) };
  const worker = new OutboxWorker(model as unknown as Model<any>);
  const work = worker.publishPending();
  let closed = false;
  const closing = worker.onModuleDestroy().then(() => {
    closed = true;
  });
  try {
    await immediate();
    expect(closed).toBe(false);
  } finally {
    finish(null);
    await work;
    await closing;
  }
  expect(closed).toBe(true);
  worker.wake();
  await immediate();
  expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
});
