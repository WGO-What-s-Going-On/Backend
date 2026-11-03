export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 1000;
export const uid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[1-9][0-9]{0,15}$/.test(v) &&
  BigInt(v) <= 9007199254740991n;
export const time = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));
export const natural = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export function check(v: unknown, label: string): asserts v {
  if (!v) throw new Error(`Invalid ${label}`);
}
export function wire(fields: Record<string, string>): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fields.data!);
  } catch {
    throw new Error('Invalid event JSON');
  }
  check(
    object(value) &&
      text(value.eventId) &&
      text(fields.eventId) &&
      value.eventId === fields.eventId,
    'event identity',
  );
  return value;
}
