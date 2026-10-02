import { describe, expect, it } from 'vitest';
import { HashPartitionStrategy } from '../src/post/application/partition.js';

describe('hash partition strategy', () => {
  const strategy = new HashPartitionStrategy();

  it('routes a normal post to bucket zero and keeps an entity stable', () => {
    expect(strategy.resolveBucket('comment-1', 1)).toBe(0);
    const first = strategy.resolveBucket('comment-1', 8);
    expect(strategy.resolveBucket('comment-1', 8)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(8);
  });

  it('distributes comment IDs across buckets without a strong skew', () => {
    const counts = Array(8).fill(0);
    for (let index = 0; index < 800; index++)
      counts[strategy.resolveBucket(`comment-${index}`, 8)]++;
    expect(Math.min(...counts)).toBeGreaterThan(65);
    expect(Math.max(...counts)).toBeLessThan(135);
  });
});
