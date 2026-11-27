// Wire contract shared with Post and the web client; not a general policy override.
export const CAMPUS_POLICY = 'CAU_CAMPUS_2026_30D' as const;
export const CAT_CONTEST_POST_ID = 'post_3b16ea1a-4de6-4a2c-85be-56a64ada2036';
export const CAT_CONTEST_EXPIRES_AT = '2026-12-24T12:52:53.893Z';
const ids = new Set([
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2031',
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2032',
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2033',
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2034',
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2035',
]);
export function isCampusEvent(p: {
  postId: string;
  lifecyclePolicy?: unknown;
  expiresAt?: unknown;
}): boolean {
  return (
    (ids.has(p.postId) ||
      (p.postId === CAT_CONTEST_POST_ID &&
        p.expiresAt === CAT_CONTEST_EXPIRES_AT)) &&
    p.lifecyclePolicy === CAMPUS_POLICY &&
    typeof p.expiresAt === 'string' &&
    Number.isFinite(Date.parse(p.expiresAt))
  );
}
