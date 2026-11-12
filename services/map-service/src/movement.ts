import { distanceM, validCoordinates, type Location } from './location.js';

// A pause without fresh samples is not evidence that a vehicle stopped.
export function decideMovement(
  samples: Location[],
  now = new Date(),
): { allowed: boolean; reason: string } {
  const denied = (reason = 'MOVEMENT_UNCONFIRMED') => ({
    allowed: false,
    reason,
  });
  const latest = samples[0];
  if (
    !latest ||
    samples.some(
      (p) =>
        !validCoordinates(p.latitude, p.longitude) ||
        !Number.isFinite(p.updatedAt.getTime()),
    )
  )
    return denied();
  if (
    latest.updatedAt.getTime() > now.getTime() ||
    now.getTime() - latest.updatedAt.getTime() > 15000
  )
    return denied();
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i]!;
    const current = samples[i - 1]!;
    const interval = current.updatedAt.getTime() - previous.updatedAt.getTime();
    if (interval <= 0 || interval > 15000) return denied();
    if ((distanceM(current, previous) / interval) * 3600 >= 20)
      return denied('USER_MOVING');
    // Ten metres accommodates GPS drift without accepting slow travel as a stop.
    if (distanceM(latest, previous) > 10) return denied();
    if (latest.updatedAt.getTime() - previous.updatedAt.getTime() >= 30000)
      return { allowed: true, reason: '' };
  }
  return denied();
}
