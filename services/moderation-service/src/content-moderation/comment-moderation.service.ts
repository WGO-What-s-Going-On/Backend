import { Inject, Injectable } from '@nestjs/common';

import {
  MODERATION_PROVIDER,
  type ModerationProvider,
} from './moderation-provider.js';
import {
  MODERATION_RESULT_REPOSITORY,
  type ModerationResultRepository,
} from './moderation-result.repository.js';
import type { StoredModerationResult } from './moderation-result.js';

export interface CommentModerationInput {
  eventId: string;
  postId: string;
  commentId: string;
  content: string;
}

@Injectable()
export class CommentModerationService {
  constructor(
    @Inject(MODERATION_PROVIDER) private readonly provider: ModerationProvider,
    @Inject(MODERATION_RESULT_REPOSITORY)
    private readonly repository: ModerationResultRepository,
  ) {}

  async moderate(
    input: CommentModerationInput,
    now = new Date(),
  ): Promise<StoredModerationResult> {
    const existing = await this.repository.find(input.eventId);
    if (existing) return existing;
    const result = await this.provider.moderate(input.content);
    const stored: StoredModerationResult = {
      ...result,
      eventId: input.eventId,
      postId: input.postId,
      commentId: input.commentId,
      moderatedAt: now.toISOString(),
    };
    await this.repository.save(stored);
    return (await this.repository.find(input.eventId)) ?? stored;
  }
}
