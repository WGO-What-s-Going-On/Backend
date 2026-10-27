import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

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
  correlationId?: string;
  authorId?: number;
  activityVersion?: number;
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
    now?: Date,
  ): Promise<StoredModerationResult> {
    const sourceHash = createHash('sha256')
      .update(JSON.stringify([input.postId, input.commentId, input.content]))
      .digest('hex');
    const existing = await this.repository.find(input.eventId);
    if (existing) {
      if (
        existing.eventId !== input.eventId ||
        existing.postId !== input.postId ||
        existing.commentId !== input.commentId ||
        (existing.sourceHash && existing.sourceHash !== sourceHash)
      )
        throw new Error('Invalid conflicting moderation source event');
      // A saved result is not completion until its output publication is confirmed.
      await this.repository.save(existing);
      return existing;
    }
    const result = await this.provider.moderate(input.content);
    const stored: StoredModerationResult = {
      ...result,
      eventId: input.eventId,
      postId: input.postId,
      commentId: input.commentId,
      moderatedAt: (now ?? new Date()).toISOString(),
      sourceHash,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      ...(input.activityVersion !== undefined
        ? { activityVersion: input.activityVersion }
        : {}),
    };
    await this.repository.save(stored);
    return (await this.repository.find(input.eventId)) ?? stored;
  }

  async republishExisting(eventId: string): Promise<void> {
    const result = await this.repository.find(eventId);
    if (result) await this.repository.save(result);
  }
}
