import { expect, it } from 'vitest';
import { decideMovement } from '../src/movement.js';
const now = new Date('2026-11-12T00:00:05Z');
const samples = (ages: number[], longitude = 127) =>
  ages.map((age) => ({
    latitude: 37,
    longitude,
    updatedAt: new Date(now.getTime() - age),
  }));
it('requires fresh continuous evidence of a thirty second stop', () => {
  expect(decideMovement(samples([0, 10000, 20000, 30000]), now).allowed).toBe(
    true,
  );
  for (const ages of [
    [],
    [0],
    [0, 10000, 20000, 29999],
    [16000, 26000, 36000, 46000],
    [0, 30000],
    [0, 0, 30000],
    [-1, 9999, 19999, 29999],
  ])
    expect(decideMovement(samples(ages), now).allowed).toBe(false);
});
it('blocks fast travel and allows a subsequent observed stop', () => {
  const moving = samples([0, 10000, 20000, 30000]);
  moving[1]!.longitude += 0.001;
  expect(decideMovement(moving, now).reason).toBe('USER_MOVING');
  expect(
    decideMovement(
      [
        ...samples([0, 10000, 20000, 30000]),
        ...moving.map((p) => ({
          ...p,
          updatedAt: new Date(p.updatedAt.getTime() - 40000),
        })),
      ],
      now,
    ).allowed,
  ).toBe(true);
});
it('accepts small GPS drift, rejects slow travel and corrupt coordinates', () => {
  const drift = samples([0, 10000, 20000, 30000]);
  drift[1]!.latitude += 0.00001;
  expect(decideMovement(drift, now).allowed).toBe(true);
  drift[3]!.latitude += 0.0002;
  expect(decideMovement(drift, now).allowed).toBe(false);
  drift[3]!.latitude = NaN;
  expect(decideMovement(drift, now).allowed).toBe(false);
});
