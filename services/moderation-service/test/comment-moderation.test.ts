import { ConfigService } from '@nestjs/config';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { CommentModerationService } from '../src/content-moderation/comment-moderation.service.js';
import {
  ModerationProviderError,
  type ModerationProvider,
} from '../src/content-moderation/moderation-provider.js';
import type { ModerationResultRepository } from '../src/content-moderation/moderation-result.repository.js';
import type { StoredModerationResult } from '../src/content-moderation/moderation-result.js';
import { OpenAiModerationAdapter } from '../src/content-moderation/openai-moderation.adapter.js';

class MemoryResults implements ModerationResultRepository {
  values = new Map<string, StoredModerationResult>();
  async find(eventId: string) {
    return this.values.get(eventId) ?? null;
  }
  async save(result: StoredModerationResult) {
    if (this.values.has(result.eventId)) return false;
    this.values.set(result.eventId, result);
    return true;
  }
}

describe('CommentModerationService', () => {
  it.each([false, true])(
    'stores safe and flagged results (flagged=%s)',
    async (flagged) => {
      const provider: ModerationProvider = {
        moderate: vi
          .fn()
          .mockResolvedValue({
            flagged,
            categories: { violence: flagged },
            categoryScores: { violence: flagged ? 0.9 : 0.01 },
            model: 'omni-moderation-latest',
          }),
      };
      const repository = new MemoryResults();
      const service = new CommentModerationService(provider, repository);
      await expect(
        service.moderate({
          eventId: 'evt_1',
          postId: 'post_1',
          commentId: 'comment_1',
          content: 'text',
        }),
      ).resolves.toMatchObject({ flagged });
    },
  );

  it('does not call OpenAI again for a duplicate event', async () => {
    const moderate = vi
      .fn()
      .mockResolvedValue({
        flagged: false,
        categories: {},
        categoryScores: {},
        model: 'omni-moderation-latest',
      });
    const service = new CommentModerationService(
      { moderate },
      new MemoryResults(),
    );
    const input = {
      eventId: 'evt_1',
      postId: 'post_1',
      commentId: 'comment_1',
      content: 'text',
    };
    await service.moderate(input);
    await service.moderate(input);
    expect(moderate).toHaveBeenCalledOnce();
  });
});

describe('OpenAiModerationAdapter', () => {
  it('maps the official SDK response into the internal result', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({
        model: 'omni-moderation-latest',
        results: [
          {
            flagged: true,
            categories: { violence: true },
            category_scores: { violence: 0.9 },
          },
        ],
      });
    const adapter = new OpenAiModerationAdapter(new ConfigService(), {
      moderations: { create },
    } as unknown as OpenAI);
    await expect(adapter.moderate('content')).resolves.toMatchObject({
      flagged: true,
      model: 'omni-moderation-latest',
    });
    expect(create).toHaveBeenCalledWith({
      model: 'omni-moderation-latest',
      input: 'content',
    });
  });

  it('surfaces OpenAI failures and marks transport errors retryable', async () => {
    const adapter = new OpenAiModerationAdapter(new ConfigService(), {
      moderations: { create: vi.fn().mockRejectedValue(new Error('timeout')) },
    } as unknown as OpenAI);
    const error = await adapter
      .moderate('content')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ModerationProviderError);
    expect((error as ModerationProviderError).retryable).toBe(true);
  });
});
