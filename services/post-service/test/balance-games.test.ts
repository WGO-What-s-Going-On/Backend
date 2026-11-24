import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  balanceContentHash,
  validateBalanceGames,
} from '../src/post/application/create-balance-games.js';
import {
  BALANCE_POST_IDS,
  CAMPUS_POST_IDS,
} from '../src/post/domain/campus-events.js';
import {
  commentId,
  postInput,
  voteSelectionId,
} from '../src/post/presentation/post.input.js';
import { validateBalanceManifest } from '../src/post/infrastructure/campus-events.preflight.js';

export const games = [
  {
    title: 'LOCAL 송강 vs 종강',
    content: 'Local synthetic fixture; never publish.',
    choices: ['송강', '종강'] as [string, string],
  },
  {
    title: 'LOCAL topic two',
    content: 'Not approved copy.',
    choices: ['A2', 'B2'] as [string, string],
  },
  {
    title: 'LOCAL topic three',
    content: 'Not approved copy.',
    choices: ['A3', 'B3'] as [string, string],
  },
];
describe('three administrator-only fixed balance polls', () => {
  it('validates the revised approved manifest and rejects the previous copy hash', () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve('../../docs/deployment/cau-balance-games.manifest.json'),
        'utf8',
      ),
    );
    const third = manifest.balanceGames[2];
    expect(third.title).toBe('🎲 A+ 독박 vs B+ 버스');
    expect(third.choices).toEqual(['A+ 독박', 'B+ 버스']);
    expect(third.content).toContain(
      'B. 자료조사·PPT·발표 아무것도 안 하고 팀원 덕에 B+',
    );
    expect(third.content).not.toContain('내 몫은 성실히');
    expect(balanceContentHash(manifest.balanceGames)).toBe(
      manifest.balanceApproval.contentSha256,
    );
    validateBalanceManifest(manifest, true);
    expect(() =>
      validateBalanceManifest(
        {
          ...manifest,
          balanceApproval: {
            ...manifest.balanceApproval,
            contentSha256:
              '0102dd91950cb7f4d4ff55eb3ac7bc7ca3f0c96446de2c9e9264494674b1dfae',
          },
        },
        true,
      ),
    ).toThrow('approval');
  });
  it('reserves separate IDs and accepts option keys only in their vote route', () => {
    expect(new Set([...CAMPUS_POST_IDS, ...BALANCE_POST_IDS]).size).toBe(5);
    for (const id of BALANCE_POST_IDS) {
      expect(voteSelectionId(id, 'option_A')).toBe('option_A');
      expect(voteSelectionId(id, 'option_B')).toBe('option_B');
      expect(() => voteSelectionId(id, 'option_C')).toThrow();
    }
    for (const id of [...CAMPUS_POST_IDS, 'ordinary'])
      expect(() => voteSelectionId(id, 'option_A')).toThrow();
    expect(() => commentId('option_A')).toThrow();
    const key = 'comment_123e4567-e89b-12d3-a456-426614174000';
    expect(voteSelectionId('ordinary', key)).toBe(key);
  });
  it.each(['balanceChoices', 'vote', 'lifecyclePolicy'])(
    'public creation cannot request %s',
    (field) => {
      expect(() =>
        postInput({
          title: 'x',
          content: 'x',
          category: 'NEWS',
          latitude: 37.5,
          longitude: 126.95,
          radiusM: 150,
          [field]: games,
        }),
      ).toThrow('Unknown field');
    },
  );
  it('requires exactly three valid games, two different options and the confirmed first topic', () => {
    expect(validateBalanceGames(games)).toEqual(games);
    expect(() => validateBalanceGames(games.slice(1))).toThrow();
    expect(() =>
      validateBalanceGames([
        { ...games[0], choices: ['x', 'x'] },
        ...games.slice(1),
      ]),
    ).toThrow();
    expect(() =>
      validateBalanceGames([
        { ...games[0], choices: ['x', 'y'] },
        ...games.slice(1),
      ]),
    ).toThrow();
  });
  it('allows unapproved dry-run but blocks apply and edits after copy approval', () => {
    const m = {
      authorId: 1,
      expectedNickname: '머준',
      location: {
        latitude: 37.5047225,
        longitude: 126.9565323,
        building: 'CAU_SEOUL_203',
        sourceUrl: 'https://example.test',
        verifiedAt: '2026-11-24T00:00:00Z',
      },
      balanceGames: games,
    };
    validateBalanceManifest(m, false);
    expect(() => validateBalanceManifest(m, true)).toThrow('approval');
    const approved = {
      ...m,
      balanceApproval: {
        contentSha256: balanceContentHash(games),
        approvedAt: '2026-11-24T00:00:00Z',
      },
    };
    validateBalanceManifest(approved, true);
    expect(() =>
      validateBalanceManifest(
        {
          ...approved,
          balanceGames: games.map((g, i) =>
            i === 1 ? { ...g, title: 'edited' } : g,
          ),
        },
        true,
      ),
    ).toThrow('approval');
    expect(() =>
      validateBalanceManifest({ ...approved, authorId: 2 }, false),
    ).toThrow('author/location');
  });
});
