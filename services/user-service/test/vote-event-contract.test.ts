import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parsePostEvent,
  UnsupportedRewardEvent,
} from '../src/rewards/post-event.js';

// Execute Post's actual wire serializer; fixtures alone cannot catch nesting/type drift.
const { serializePostEvent } = await import(
  new URL(
    '../../post-service/src/post/infrastructure/post-event-envelope.ts',
    import.meta.url,
  ).href
);
const postId = `post_${randomUUID()}`;
const commentId = `comment_${randomUUID()}`;
const selectedAt = '2026-11-02T03:00:00.000Z';
const closedAt = '2026-11-02T04:00:00.000Z';
function row(kind: 'candidate' | 'vote', extra: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${randomUUID()}`,
    eventType:
      kind === 'candidate' ? 'PostVoteCandidateSelected' : 'PostVoteWon',
    aggregateId: postId,
    producer: 'post-service',
    schemaVersion: 1,
    correlationId: 'post-user-contract',
    occurredAt: new Date('2026-11-03T00:00:00Z'),
    payload: {
      activityVersion: 1,
      [kind]: {
        postId,
        commentId,
        ...(kind === 'candidate'
          ? {
              authorId: 42,
              scoreAtSelection: 999,
              selectedAt: new Date(selectedAt),
            }
          : {
              resultId: postId,
              winnerAuthorId: 42,
              votes: 3,
              closedAt: new Date(closedAt),
            }),
        ...extra,
      },
    },
  };
}
function wire(source: ReturnType<typeof row>) {
  return {
    eventId: source.eventId,
    eventType: source.eventType,
    data: serializePostEvent(source),
  };
}
describe('Post producer / User vote contract', () => {
  it.each(['candidate', 'vote'] as const)(
    'consumes actual %s serialization and source time rather than envelope time',
    (kind) => {
      const input = parsePostEvent(
        wire(row(kind, { regionCode: '1159053000' })),
      )!;
      expect(input).toMatchObject({
        actorId: '42',
        beneficiaryId: '42',
        regionCode: '1159053000',
        occurredAt: kind === 'candidate' ? selectedAt : closedAt,
        key:
          kind === 'candidate'
            ? `candidate:${postId}:${commentId}`
            : `vote:${postId}`,
      });
      if (kind === 'candidate') expect(input.scoreAtSelection).toBe(999);
      expect(input).not.toHaveProperty('postRegion');
    },
  );
  it.each(['candidate', 'vote'] as const)(
    'distinguishes null and legacy missing region in %s',
    (kind) => {
      expect(
        parsePostEvent(wire(row(kind, { regionCode: null })))!.regionCode,
      ).toBeNull();
      expect(parsePostEvent(wire(row(kind)))!).not.toHaveProperty('regionCode');
    },
  );
  it.each(['candidate', 'vote'] as const)(
    'rejects malformed %s region in both producer and consumer',
    (kind) => {
      for (const regionCode of [
        '',
        '11590',
        '11590530000',
        1159053000,
        {},
        'abcdefghij',
      ]) {
        const source = row(kind, { regionCode });
        expect(() => serializePostEvent(source)).toThrow();
        const fields = wire(row(kind));
        const value = JSON.parse(fields.data);
        value[kind].regionCode = regionCode;
        expect(() =>
          parsePostEvent({ ...fields, data: JSON.stringify(value) }),
        ).toThrow();
      }
    },
  );
  it.each([
    { scoreAtSelection: -1 },
    { scoreAtSelection: 1.5 },
    { authorId: '42' },
    { selectedAt: 'invalid' },
    { commentId: postId },
    { postId: commentId },
  ])('rejects invalid candidate facts %j', (extra) => {
    const fields = wire(row('candidate'));
    const value = JSON.parse(fields.data);
    Object.assign(value.candidate, extra);
    expect(() =>
      parsePostEvent({ ...fields, data: JSON.stringify(value) }),
    ).toThrow();
  });
  it('does not adopt the unimplemented region correction event on the live contract', () => {
    const fields = wire(row('candidate'));
    const value = JSON.parse(fields.data);
    value.eventType = 'PostRegionResolved';
    expect(() =>
      parsePostEvent({
        ...fields,
        eventType: value.eventType,
        data: JSON.stringify(value),
      }),
    ).toThrow(UnsupportedRewardEvent);
  });
});
