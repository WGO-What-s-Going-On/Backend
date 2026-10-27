import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../src/lifecycle/clock.js';
import { LifecycleScheduler } from '../src/lifecycle/lifecycle.scheduler.js';
import type { LifecycleService } from '../src/lifecycle/lifecycle.service.js';

describe('LifecycleScheduler', () => {
  it('waits for an in-flight batch on shutdown and stops further evaluations', async () => {
    let release!: (ids: string[]) => void;
    const due = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const evaluate = vi.fn();
    const scheduler = new LifecycleScheduler(
      { due, evaluate } as unknown as LifecycleService,
      { now: () => new Date() },
    );
    const scanning = scheduler.scan();
    const stopping = scheduler.onModuleDestroy();
    release(['p']);
    await Promise.all([scanning, stopping]);
    expect(evaluate).not.toHaveBeenCalled();
    await scheduler.scan();
    expect(due).toHaveBeenCalledOnce();
  });
  it('uses the injected clock and scans every projection', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const lifecycle = {
      due: vi.fn().mockResolvedValue(['post_1', 'post_2']),
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
      due: vi.fn().mockImplementation(() => waiting.then(() => [])),
      evaluate: vi.fn(),
    } as unknown as LifecycleService;
    const scheduler = new LifecycleScheduler(lifecycle, {
      now: () => new Date(),
    });
    const first = scheduler.scan();
    await scheduler.scan();
    expect(lifecycle.due).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
