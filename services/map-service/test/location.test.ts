import { describe, expect, it } from 'vitest';
import { decide, distanceM } from '../src/location.js';

describe('location decision', () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const center = { latitude: 37.5, longitude: 127 };
  it('requires a location no older than five minutes', () => {
    expect(decide(null, center, 100, now).reason).toBe('LOCATION_MISSING');
    expect(
      decide(
        { ...center, updatedAt: new Date(now.getTime() - 300001) },
        center,
        100,
        now,
      ).reason,
    ).toBe('LOCATION_STALE');
    expect(
      decide(
        { ...center, updatedAt: new Date(now.getTime() - 300000) },
        center,
        100,
        now,
      ).allowed,
    ).toBe(true);
  });
  it('uses exact coordinate distance including the boundary', () => {
    const point = { latitude: 37.5009, longitude: 127, updatedAt: now };
    const distance = distanceM(point, center);
    expect(decide(point, center, distance, now).allowed).toBe(true);
    expect(decide(point, center, distance - 0.001, now).reason).toBe(
      'OUTSIDE_RADIUS',
    );
  });
});
