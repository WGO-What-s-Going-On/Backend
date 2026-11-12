import { expect, it } from 'vitest';
import { advanceMovement, type MovementState } from '../src/movement.js';
const point = (ms: number, longitude = 127) => ({
  latitude: 37,
  longitude,
  updatedAt: new Date(ms),
});
const moving = () =>
  advanceMovement(advanceMovement(null, point(0, 126.999)), point(10000));
it('allows the first location without a mandatory stop', () => {
  expect(advanceMovement(null, point(0)).reason).toBe('');
});
it('allows ordinary walking without requiring stationary samples', () => {
  let state: MovementState | null = null;
  for (let i = 0; i < 10; i++)
    state = advanceMovement(state, point(i * 10000, 127 + i * 0.0001));
  expect(state?.reason).toBe('');
});
it('blocks at 20km/h and releases at exactly ten observed stationary seconds', () => {
  const blocked = moving();
  expect(blocked.reason).toBe('USER_MOVING');
  const waiting = advanceMovement(blocked, point(19999));
  expect(waiting.reason).toBe('MOVEMENT_UNCONFIRMED');
  expect(advanceMovement(waiting, point(20000)).reason).toBe('');
});
it('does not release merely because updates paused or history expired', () => {
  const resumed = advanceMovement(moving(), point(7 * 86400000));
  expect(resumed.reason).toBe('MOVEMENT_UNCONFIRMED');
  expect(advanceMovement(resumed, point(7 * 86400000 + 9999)).reason).not.toBe(
    '',
  );
  expect(advanceMovement(resumed, point(7 * 86400000 + 10000)).reason).toBe('');
});
it('restarts the stop after renewed fast movement or displacement beyond ten metres', () => {
  const again = advanceMovement(moving(), point(15000, 127.001));
  expect(again.reason).toBe('USER_MOVING');
  expect(advanceMovement(again, point(20000, 127.001)).reason).not.toBe('');
  expect(advanceMovement(again, point(25000, 127.001)).reason).toBe('');
  const walking = advanceMovement(moving(), point(20000, 127.0002));
  expect(walking.reason).toBe('MOVEMENT_UNCONFIRMED');
});
it('does not roll state back on late writes, or count repeated timestamps as a stop', () => {
  const blocked = moving();
  expect(advanceMovement(blocked, point(9999))).toBe(blocked);
  expect(advanceMovement(blocked, point(10000)).reason).not.toBe('');
  expect(() => advanceMovement(blocked, point(20000, NaN))).toThrow();
});
it('detects the inclusive speed threshold and tolerates small drift during the stop', () => {
  const delta = (((20 / 3.6) * 10) / 6371008.8) * (180 / Math.PI);
  const start = { ...point(0), latitude: 0, longitude: 0 };
  const atSpeed = (factor: number) =>
    advanceMovement(advanceMovement(null, start), {
      ...start,
      latitude: delta * factor,
      updatedAt: new Date(10000),
    });
  expect(atSpeed(1).reason).toBe('USER_MOVING');
  expect(atSpeed(0.999).reason).toBe('');
  expect(advanceMovement(moving(), point(20000, 127.00001)).reason).toBe('');
});

it('blocks fast movement even when the newer concurrent observation arrived first', () => {
  const newer = advanceMovement(null, point(10000));
  const late = advanceMovement(newer, point(0, 126.999));
  expect(late.location).toEqual(newer.location);
  expect(late.reason).toBe('USER_MOVING');
});
