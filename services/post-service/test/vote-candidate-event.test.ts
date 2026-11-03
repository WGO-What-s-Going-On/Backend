import { describe, expect, it } from 'vitest';
import { event } from '../src/post/application/event.js';
import type { EventType } from '../src/post/application/ports.js';
import {
  InvalidOutboxEvent,
  serializePostEvent,
} from '../src/post/infrastructure/post-event-envelope.js';

const postId = 'post_11111111-1111-4111-8111-111111111111';
const candidate = {
  postId,
  commentId: 'comment_22222222-2222-4222-8222-222222222222',
  authorId: 123,
  scoreAtSelection: 0,
  selectedAt: new Date('2026-01-01T00:30:00.000Z'),
};
const row = () =>
  event(
    postId,
    'PostVoteCandidateSelected',
    { candidate, activityVersion: 1 },
    candidate.selectedAt,
  );

describe('vote candidate event contract', () => {
  it('accepts a zero-score candidate and flattens the payload', () => {
    expect(JSON.parse(serializePostEvent(row()))).toMatchObject({
      eventType: 'PostVoteCandidateSelected',
      activityVersion: 1,
      candidate: {
        ...candidate,
        selectedAt: candidate.selectedAt.toISOString(),
      },
    });
  });

  it.each([
    { postId: 'post_other' },
    { commentId: 'invalid' },
    { authorId: undefined },
    { authorId: 0 },
    { authorId: '123' },
    { scoreAtSelection: undefined },
    { scoreAtSelection: -1 },
    { scoreAtSelection: 1.5 },
    { scoreAtSelection: Number.MAX_SAFE_INTEGER + 1 },
    { selectedAt: undefined },
    { selectedAt: 'invalid' },
  ])('rejects invalid candidate fields %j', (change) => {
    const value = row();
    value.payload = {
      candidate: { ...candidate, ...change },
      activityVersion: 1,
    };
    expect(() => serializePostEvent(value)).toThrow(InvalidOutboxEvent);
  });

  it.each([undefined, 0, 2, '1'])(
    'rejects candidate activityVersion %s',
    (activityVersion) => {
      const value = row();
      value.payload = { candidate, activityVersion };
      expect(() => serializePostEvent(value)).toThrow(InvalidOutboxEvent);
    },
  );
});

describe.each([
  {
    eventType: 'PostVoteCandidateSelected',
    key: 'candidate',
    target: candidate,
  },
  {
    eventType: 'PostVoteWon',
    key: 'vote',
    target: {
      postId,
      resultId: postId,
      commentId: candidate.commentId,
      winnerAuthorId: candidate.authorId,
      votes: 1,
      closedAt: candidate.selectedAt,
    },
  },
] satisfies { eventType: EventType; key: string; target: object }[])(
  '$eventType region compatibility',
  ({ eventType, key, target }) => {
    it.each(['1159053000', null, undefined])(
      'preserves regionCode %s including historical omissions',
      (regionCode) => {
        const stored = event(
          postId,
          eventType,
          {
            [key]: {
              ...target,
              ...(regionCode === undefined ? {} : { regionCode }),
            },
            activityVersion: 1,
          },
          candidate.selectedAt,
        );
        const wire = JSON.parse(serializePostEvent(stored));
        if (regionCode === undefined)
          expect(wire[key]).not.toHaveProperty('regionCode');
        else expect(wire[key].regionCode).toBe(regionCode);
      },
    );

    it.each([1159053000, '', '123', '11590530000', '115905300x', true, {}])(
      'rejects invalid regionCode %j',
      (regionCode) => {
        const stored = event(
          postId,
          eventType,
          { [key]: { ...target, regionCode }, activityVersion: 1 },
          candidate.selectedAt,
        );
        expect(() => serializePostEvent(stored)).toThrow(InvalidOutboxEvent);
      },
    );
  },
);
