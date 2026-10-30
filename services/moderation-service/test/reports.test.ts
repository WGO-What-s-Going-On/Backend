import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
  it('checks real HTTP responses, ownership of comments, expiry, unavailable and bounded pagination', async () => {
    let mode = 'post';
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (mode === 'missing') {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      if (mode === 'down') {
        res.writeHead(500);
        res.end('{}');
        return;
      }
      const payload = req.url?.includes('/comments')
        ? {
            comments:
              mode === 'comment'
                ? [{ postId, commentId, status: 'ACTIVE' }]
                : [],
            nextCursor: mode === 'budget' ? 'repeat' : null,
          }
        : {
            postId,
            status: 'ACTIVE',
            expiresAt: mode === 'expired' ? '2020-01-01T00:00:00.000Z' : null,
          };
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const target = new ReportTarget(
      new ConfigService({
        reports: { postUrl: `http://127.0.0.1:${address.port}` },
      }),
    );
    try {
      await target.verify(parseReport(input));
      mode = 'comment';
      await target.verify(
        parseReport({ ...input, targetType: 'COMMENT', commentId }),
      );
      mode = 'post';
      await expect(
        target.verify(
          parseReport({ ...input, targetType: 'COMMENT', commentId }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      mode = 'expired';
      await expect(target.verify(parseReport(input))).rejects.toMatchObject({
        status: 404,
      });
      mode = 'missing';
      await expect(target.verify(parseReport(input))).rejects.toMatchObject({
        status: 404,
      });
      mode = 'down';
      await expect(target.verify(parseReport(input))).rejects.toMatchObject({
        status: 503,
      });
      mode = 'budget';
      await expect(
        target.verify(
          parseReport({ ...input, targetType: 'COMMENT', commentId }),
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
  it('fails closed without target configuration', async () => {
    await expect(
      new ReportTarget(new ConfigService()).verify(parseReport(input)),
    ).rejects.toMatchObject({ status: 503 });
  });
});
