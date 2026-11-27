import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostEvent } from '../src/rewards/post-event.js';
it('keeps the cat contest creation as one existing POST activity, without a fabricated vote reward', () => {
  const e = JSON.parse(
    readFileSync(
      resolve('../../docs/contracts/fixtures/cat-contest-post-created.json'),
      'utf8',
    ),
  );
  expect(
    parsePostEvent({
      eventId: e.eventId,
      eventType: e.eventType,
      data: JSON.stringify(e),
    }),
  ).toMatchObject({
    postId: e.aggregateId,
    kind: 'POST',
    actorId: '1',
    active: true,
  });
});
it.each([1, 2, 3, 4, 5])(
  'counts administrator campaign creation as the existing Post activity contract (reserved %s)',
  (suffix) => {
    const original = readFileSync(
      resolve('../../docs/contracts/fixtures/campus-post-created.json'),
      'utf8',
    );
    const e = JSON.parse(original);
    e.aggregateId = `post_3b16ea1a-4de6-4a2c-85be-56a64ada203${suffix}`;
    e.post.postId = e.aggregateId;
    const data = JSON.stringify(e);
    const result = parsePostEvent({
      eventId: e.eventId,
      eventType: e.eventType,
      data,
    });
    expect(result).toMatchObject({
      postId: e.aggregateId,
      kind: 'POST',
      actorId: '42',
      active: true,
    });
  },
);
