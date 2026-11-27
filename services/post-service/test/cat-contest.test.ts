import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAT_CONTEST_COPY,
  CAT_CONTEST_EXPIRES_AT,
  CAT_CONTEST_LOCATION,
  CAT_CONTEST_POST_ID,
} from '../src/post/domain/cat-contest.js';
import {
  BALANCE_POST_IDS,
  CAMPUS_POLICY,
  CAMPUS_POST_IDS,
  isBalanceEvent,
  isCampusEvent,
} from '../src/post/domain/campus-events.js';
import {
  validateCampusManifest,
  validateCatContestManifest,
} from '../src/post/infrastructure/campus-events.preflight.js';
import { postInput } from '../src/post/presentation/post.input.js';

describe('one administrator cat photo contest', () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve('../../docs/deployment/cau-cat-contest.manifest.json'),
      'utf8',
    ),
  );
  it('pins a sixth identity, moved location and the originals exact deadline', () => {
    expect(
      new Set([...CAMPUS_POST_IDS, ...BALANCE_POST_IDS, CAT_CONTEST_POST_ID])
        .size,
    ).toBe(6);
    expect(validateCampusManifest(manifest, false)).toEqual(manifest);
    validateCatContestManifest(manifest);
    expect(manifest.catContest).toEqual({
      postId: CAT_CONTEST_POST_ID,
      ...CAT_CONTEST_COPY,
      expiresAt: CAT_CONTEST_EXPIRES_AT,
    });
    expect(manifest.location).toMatchObject(CAT_CONTEST_LOCATION);
    expect(
      isCampusEvent({
        postId: CAT_CONTEST_POST_ID,
        lifecyclePolicy: CAMPUS_POLICY,
      }),
    ).toBe(true);
    expect(
      isBalanceEvent({
        postId: CAT_CONTEST_POST_ID,
        lifecyclePolicy: CAMPUS_POLICY,
      }),
    ).toBe(false);
    expect(
      isCampusEvent({ postId: 'ordinary', lifecyclePolicy: CAMPUS_POLICY }),
    ).toBe(false);
    expect(isCampusEvent({ postId: CAT_CONTEST_POST_ID })).toBe(false);
  });
  it.each([
    { authorId: 2 },
    { expectedNickname: '머준' },
    { balanceGames: [] },
    { catContest: { ...manifest.catContest, postId: CAMPUS_POST_IDS[0] } },
    {
      catContest: {
        ...manifest.catContest,
        expiresAt: '2026-12-27T12:00:00.000Z',
      },
    },
    { catContest: { ...manifest.catContest, title: 'changed' } },
    { catContest: { ...manifest.catContest, content: 'changed' } },
    { location: { ...manifest.location, latitude: 37.5047225 } },
    { location: { ...manifest.location, building: 'CAU_SEOUL_203' } },
  ])('rejects changing the approved scope: %j', (change) => {
    expect(() =>
      validateCatContestManifest({ ...manifest, ...change }),
    ).toThrow('Exact administrator');
  });
  it('keeps public creation unable to request this policy or reserved identity', () => {
    const input = {
      title: 'x',
      content: 'x',
      category: 'NEWS',
      ...CAT_CONTEST_LOCATION,
      radiusM: 350,
    };
    for (const field of [
      'catContest',
      'postId',
      'expiresAt',
      'lifecyclePolicy',
    ])
      expect(() =>
        postInput({ ...input, [field]: CAT_CONTEST_POST_ID }),
      ).toThrow('Unknown field');
  });
});
