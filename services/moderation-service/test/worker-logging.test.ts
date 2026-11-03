import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScheduler } from '../src/lifecycle/lifecycle.scheduler.js';
import type { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
afterEach(() => vi.restoreAllMocks());
describe('background lifecycle logging', () => {
  it('identifies failed post evaluation and still processes later posts without exposing exceptions', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (line: string | Uint8Array) => {
        lines.push(String(line));
        return true;
      },
    );
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('private content'))
      .mockResolvedValueOnce(undefined);
    const scheduler = new LifecycleScheduler(
      {
        due: async () => ['post-1', 'post-2'],
        evaluate,
      } as unknown as LifecycleService,
      { now: () => new Date() },
    );
    await scheduler.scan();
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'lifecycle_evaluation_failed',
        service: 'moderation-service',
        domain: 'lifecycle',
        outcome: 'failure',
        postId: 'post-1',
        error: expect.objectContaining({
          code: 'LIFECYCLE_EVALUATION_FAILED',
          retryable: true,
        }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'lifecycle_scan_completed',
        outcome: 'success',
        count: 1,
      }),
    );
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(lines.join('')).not.toContain('private content');
  });
});
