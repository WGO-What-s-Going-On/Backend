import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostEvent } from '../src/rewards/post-event.js';
it('counts administrator campaign creation as the existing Post activity contract', () => {
  const data = readFileSync(
    resolve('../../docs/contracts/fixtures/campus-post-created.json'),
    'utf8',
  );
  const e = JSON.parse(data);
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
});
