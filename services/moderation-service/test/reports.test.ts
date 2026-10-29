import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from 'redis';
import { reportInput, ReportsService } from '../src/reports.js';

describe('report input', () => {
  const body = {
    targetType: 'POST',
    targetId: `post_${randomUUID()}`,
    reason: ' spam ',
  };
  it('normalizes a reason and rejects invalid targets or oversized text', () => {
    expect(reportInput(body).reason).toBe('spam');
    for (const input of [
      null,
      { ...body, targetType: 'USER' },
      { ...body, reason: ' ' },
      { ...body, reason: 'x'.repeat(1001) },
      { ...body, targetId: 'comment_invalid' },
      { ...body, reporterId: '2' },
    ]) {
      expect(() => reportInput(input)).toThrow();
    }
  });
});

describe.skipIf(process.env.RUN_INTEGRATION !== '1')(
  'report persistence',
  () => {
    it('keeps the first reason across retries and separates reporters', async () => {
      const url = process.env.REPORT_TEST_REDIS_URL ?? 'redis://127.0.0.1:6383';
      const service = new ReportsService(new ConfigService({ redis: { url } }));
      const client = createClient({ url });
      await client.connect();
      const body = {
        targetType: 'COMMENT',
        targetId: `comment_${randomUUID()}`,
        reason: 'first reason',
      };
      const keys = ['123', '456'].map(
        (id) =>
          `moderation:report:${createHash('sha256')
            .update(JSON.stringify([id, body.targetType, body.targetId]))
            .digest('hex')}`,
      );
      try {
        const first = await service.create('123', body);
        expect(
          await service.create('123', { ...body, reason: 'retry changed' }),
        ).toEqual(first);
        expect((await service.create('456', body)).reportId).not.toBe(
          first.reportId,
        );
        expect(JSON.parse((await client.get(keys[0]!))!).reason).toBe(
          'first reason',
        );
      } finally {
        await client.del(keys);
        await client.quit();
        await service.onModuleDestroy();
      }
    });
  },
);
