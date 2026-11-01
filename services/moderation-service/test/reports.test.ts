import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { parseReport } from '../src/reports/report.dto.js';
import { ReportTarget } from '../src/reports/report-target.js';
import { ReportStore } from '../src/reports/report.store.js';
const postId = 'post_123e4567-e89b-42d3-a456-426614174000';
const commentId = 'comment_123e4567-e89b-42d3-a456-426614174000';
const input = { targetType: 'POST', postId, reason: 'SPAM' };
afterEach(() => vi.restoreAllMocks());
describe('report validation and live Post read adapter', () => {
  it.each([
    'post:events',
    'moderation:events',
    'moderation:content-events',
    'moderation:reports:v1:records',
    'moderation:reports:v1:pending',
  ])(
    'refuses to use existing stream/storage key %s as report output',
    (eventStream) => {
      expect(
        () => new ReportStore(new ConfigService({ reports: { eventStream } })),
      ).toThrow('Report events require a separate stream');
    },
  );
  it('validates discriminated target fields, reasons, IDs and description bounds', () => {
    expect(parseReport(input)).toEqual(input);
    expect(
      parseReport({ ...input, targetType: 'COMMENT', commentId }),
    ).toMatchObject({ commentId });
    for (const invalid of [
      null,
      [],
      {},
      { ...input, reason: 'bad' },
      { ...input, postId: 'post_no' },
      { targetType: 'POST', targetId: postId, reason: 'SPAM' },
      { ...input, commentId },
      { ...input, targetType: 'COMMENT' },
      { ...input, description: 'x'.repeat(2001) },
      { ...input, reporterUserId: '1' },
    ])
      expect(() => parseReport(invalid)).toThrow();
  });
  it.each(['POST', 'COMMENT'] as const)(
    'fails closed for %s without making an unauthenticated Post call',
    async (targetType) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      await expect(
        new ReportTarget().verify(
          parseReport({
            ...input,
            targetType,
            ...(targetType === 'COMMENT' ? { commentId } : {}),
          }),
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
