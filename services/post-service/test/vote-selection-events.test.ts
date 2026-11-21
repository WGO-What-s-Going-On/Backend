import { describe, expect, it } from 'vitest';
import { event } from '../src/post/application/event.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';
// Load adjacent services at runtime without adding their sources to this service's TS root.
const userModule = new URL(
  '../../user-service/src/rewards/post-event.ts',
  import.meta.url,
).href;
const notificationModule = new URL(
  '../../notification-service/src/event-consumer/post-event.ts',
  import.meta.url,
).href;
const moderationModule = new URL(
  '../../moderation-service/src/event-consumer/post-event.ts',
  import.meta.url,
).href;
const { parsePostEvent: userParser } = await import(userModule);
const { parsePostEvent: notificationParser } = await import(notificationModule);
const { parsePostEvent: moderationParser } = await import(moderationModule);

const p = 'post_11111111-1111-4111-8111-111111111111',
  c = 'comment_22222222-2222-4222-8222-222222222222';
describe('vote selection wire compatibility', () => {
  it.each([c, null])(
    'serializes selection %s for User, while Notification and Moderation ignore without error',
    (commentId) => {
      const now = new Date();
      const stored = event(
        p,
        'PostVoteSelectionChanged',
        {
          voteSelection: { postId: p, userId: 1, commentId, updatedAt: now },
          activityVersion: 5,
        },
        now,
      );
      const data = serializePostEvent(stored),
        fields = { data, eventId: stored.eventId, eventType: stored.eventType };
      expect(userParser(fields)).toMatchObject({
        kind: 'VOTE_SELECTION',
        actorId: '1',
        version: 5,
        active: commentId !== null,
        voteSelection: { commentId },
      });
      expect(notificationParser(data, fields)).toBeNull();
      expect(moderationParser(fields)).toBeNull();
    },
  );
  it.each([0, -1, 1.5, undefined])(
    'rejects invalid monotonic selection version %s',
    (activityVersion) => {
      const now = new Date();
      expect(() =>
        serializePostEvent(
          event(
            p,
            'PostVoteSelectionChanged',
            {
              voteSelection: {
                postId: p,
                userId: 1,
                commentId: c,
                updatedAt: now,
              },
              activityVersion,
            },
            now,
          ),
        ),
      ).toThrow();
    },
  );
});
