import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';

import { OpenAiModerationAdapter } from '../../src/content-moderation/openai-moderation.adapter.js';
import { group, redisHarness, stream } from '../integration/redis-harness.js';

it.skipIf(!process.env.OPENAI_API_KEY)(
  'production OpenAI adapter and Redis comment flow',
  async () => {
    const adapter = new OpenAiModerationAdapter(
      new ConfigService({ openai: { apiKey: process.env.OPENAI_API_KEY } }),
    );
    // 오류 cause에는 SDK 요청 정보가 들어갈 수 있으므로 credential을 포함할 수 있는 예외는 출력하지 않는다.
    try {
      for (const [label, content, flagged] of [
        ['safe', 'Have a lovely day!', false],
        ['flagged', 'I will kill you.', true],
      ] as const) {
        const result = await adapter.moderate(content);
        expect(result.flagged).toBe(flagged);
        expect(
          Object.values(result.categories).every(
            (value) => typeof value === 'boolean',
          ),
        ).toBe(true);
        expect(
          Object.values(result.categoryScores).every(
            (value) => typeof value === 'number' && value >= 0 && value <= 1,
          ),
        ).toBe(true);
        expect(Object.keys(result.categories).length).toBeGreaterThan(0);
        expect(Object.keys(result.categoryScores).sort()).toEqual(
          Object.keys(result.categories).sort(),
        );
        expect(result.model).toMatch(/^omni-moderation/);
        console.info(
          `OpenAI ${label}: flagged=${result.flagged}, model=${result.model}, parsing=passed`,
        );
      }
      const h = await redisHarness(adapter);
      try {
        await h.prepare();
        const id = h.postId();
        await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
        const message = h.fields(
          'PostCommentCreated',
          id,
          '2026-01-01T00:01:00.000Z',
        );
        await h.send(message);
        expect(await h.results.find(message.eventId)).toMatchObject({
          flagged: false,
          postId: id,
        });
        expect(await h.lifecycle.list()).toMatchObject([
          { postId: id, lastMeaningfulActivityAt: '2026-01-01T00:01:00.000Z' },
        ]);
        expect((await h.redis.xPending(stream, group)).pending).toBe(0);
        expect(await h.redis.get(`moderation:dedup:${message.eventId}`)).toBe(
          'done',
        );
      } finally {
        await h.cleanup();
      }
    } catch {
      throw new Error(
        'OpenAI smoke failed; credentials and SDK error details suppressed',
      );
    }
  },
);

if (!process.env.OPENAI_API_KEY)
  console.info('OpenAI smoke test skipped: OPENAI_API_KEY unavailable');
