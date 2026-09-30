export const MAX_USER_ID = 9_007_199_254_740_991n;

export function parseUserId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= MAX_USER_ID ? parsed.toString() : undefined;
}
