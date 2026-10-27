export class InvalidMediaError extends Error {}

export const MAX_MEDIA = 5;
export const MEDIA_ID =
  /^media_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
] as const;
export type MediaContentType = (typeof MEDIA_TYPES)[number];
export function mediaIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_MEDIA ||
    value.some((id) => typeof id !== 'string' || !MEDIA_ID.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new InvalidMediaError(
      'mediaIds must contain at most 5 unique media IDs',
    );
  return [...value];
}
