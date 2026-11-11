import { expect, it } from 'vitest';
import { event } from '../src/post/application/event.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';

const postId = 'post_11111111-1111-4111-8111-111111111111';
function row(fields: Record<string, unknown>, version: unknown = 1) {
  return event(
    postId,
    'PostCreated',
    {
      post: {
        postId,
        authorId: 1,
        category: 'NEWS',
        latitude: 37.5,
        longitude: 127,
        radiusM: 100,
        expiresAt: null,
        ...fields,
      },
      postVersion: version,
    },
    new Date('2026-11-09T00:00:00.000Z'),
  );
}
it('preserves title/body snapshots and remains compatible with bodyless historical Outbox', () => {
  const source = row({ title: 'Title', content: 'Body' });
  expect(JSON.parse(serializePostEvent(source))).toMatchObject({
    post: { title: 'Title', content: 'Body' },
    postVersion: 1,
  });
  expect(JSON.parse(serializePostEvent(row({})))).not.toHaveProperty(
    'post.content',
  );
});
it.each([
  { title: 'Title' },
  { content: 'Body' },
  { title: '', content: 'Body' },
  { title: 'a'.repeat(121), content: 'Body' },
  { title: 'Title', content: 'a'.repeat(5001) },
])('rejects a damaged Outbox snapshot before publication %j', (fields) => {
  expect(() => serializePostEvent(row(fields))).toThrow();
});
it('requires the source version when an Outbox contains a content snapshot', () => {
  const source = row({ title: 'Title', content: 'Body' });
  delete source.payload.postVersion;
  expect(() => serializePostEvent(source)).toThrow();
});
