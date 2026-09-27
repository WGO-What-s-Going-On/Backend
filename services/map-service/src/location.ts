export type Location = { latitude: number; longitude: number; updatedAt: Date };
export interface LocationStore {
  put(userId: number, location: Location): Promise<void>;
  get(userId: number): Promise<Location | null>;
}

const maxAgeMs = 5 * 60 * 1000;
const earthRadiusM = 6371008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function validCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function decide(
  location: Location | null,
  center: { latitude: number; longitude: number },
  radiusM: number,
  now = new Date(),
): { allowed: boolean; reason: string } {
  if (!location) return { allowed: false, reason: 'LOCATION_MISSING' };
  if (
    location.updatedAt.getTime() > now.getTime() + 5000 ||
    now.getTime() - location.updatedAt.getTime() > maxAgeMs
  )
    return { allowed: false, reason: 'LOCATION_STALE' };
  if (distanceM(location, center) > radiusM)
    return { allowed: false, reason: 'OUTSIDE_RADIUS' };
  return { allowed: true, reason: '' };
}
