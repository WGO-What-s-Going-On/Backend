import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../src/lifecycle/clock.js';
import { LifecycleScheduler } from '../src/lifecycle/lifecycle.scheduler.js';
import type { LifecycleService } from '../src/lifecycle/lifecycle.service.js';

describe('LifecycleScheduler', () => {
  it('uses the injected clock and scans every projection', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const lifecycle = {
      list: vi
        .fn()
        .mockResolvedValue([{ postId: 'post_1' }, { postId: 'post_2' }]),
      evaluate,
    } as unknown as LifecycleService;
    const now = new Date('2026-01-01T01:00:00.000Z');
    const clock: Clock = { now: () => now };
    const scheduler = new LifecycleScheduler(lifecycle, clock);
    await scheduler.scan();
    expect(evaluate).toHaveBeenNthCalledWith(1, 'post_1', now);
    expect(evaluate).toHaveBeenNthCalledWith(2, 'post_2', now);
  });

  it('does not overlap scans', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = {
      list: vi.fn().mockImplementation(() => waiting.then(() => [])),
      evaluate: vi.fn(),
    } as unknown as LifecycleService;
    const scheduler = new LifecycleScheduler(lifecycle, {
      now: () => new Date(),
    });
    const first = scheduler.scan();
    await scheduler.scan();
    expect(lifecycle.list).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
