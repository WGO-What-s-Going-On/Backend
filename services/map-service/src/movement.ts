import { distanceM, validCoordinates, type Location } from './location.js';

export type MovementState = {
  location: Location;
  stop: Location;
  reason: '' | 'USER_MOVING' | 'MOVEMENT_UNCONFIRMED';
};

export function advanceMovement(
  previous: MovementState | null,
  location: Location,
): MovementState {
  if (
    !validCoordinates(location.latitude, location.longitude) ||
    !Number.isFinite(location.updatedAt.getTime())
  )
    throw new Error('Invalid movement location');
  const clear: MovementState = { location, stop: location, reason: '' };
  if (!previous) return clear;
  const interval =
    location.updatedAt.getTime() - previous.location.updatedAt.getTime();
  // Delayed writes must not undo a newer detection or advance its stop timer.
  const distance = distanceM(location, previous.location);
  if (interval < 0) {
    // Even an out-of-order observation may reveal travel missed by the winning writer.
    return (distance / -interval) * 3600 >= 20
      ? { ...previous, stop: previous.location, reason: 'USER_MOVING' }
      : previous;
  }
  if (
    (interval > 0 && (distance / interval) * 3600 >= 20) ||
    (interval === 0 && distance > 10)
  )
    return { location, stop: location, reason: 'USER_MOVING' };
  if (!previous.reason) return clear;
  // Missing samples are not proof of a stop. Keep the block across arbitrarily long gaps.
  if (interval > 15000 || distanceM(location, previous.stop) > 10)
    return { location, stop: location, reason: 'MOVEMENT_UNCONFIRMED' };
  if (location.updatedAt.getTime() - previous.stop.updatedAt.getTime() >= 10000)
    return clear;
  return { location, stop: previous.stop, reason: 'MOVEMENT_UNCONFIRMED' };
}
