import { createLogger } from '../observability/logging.js';
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

export type ContentModerationInput = {
  eventId: string;
  postId: string;
  content: string;
  correlationId?: string;
  authorId?: number;
} & (
  | { targetType: 'POST'; title: string; postVersion: number }
  | { targetType: 'COMMENT'; commentId: string; activityVersion?: number }
);

@Injectable()
export class ContentModerationService {
  private readonly logger = createLogger('moderation-service', 'content');
  constructor(
    @Inject(MODERATION_PROVIDER) private readonly provider: ModerationProvider,
    @Inject(MODERATION_RESULT_REPOSITORY)
    private readonly repository: ModerationResultRepository,
  ) {}

  async moderate(
    input: ContentModerationInput,
    now?: Date,
  ): Promise<StoredModerationResult> {
    // Keep the original comment hash so retained results survive the rollout.
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify(
          input.targetType === 'POST'
            ? [
                'POST',
                input.postId,
                input.postVersion,
                input.title,
                input.content,
              ]
            : [input.postId, input.commentId, input.content],
        ),
      )
      .digest('hex');
    const context = {
      eventId: input.eventId,
      postId: input.postId,
      ...(input.targetType === 'COMMENT'
        ? { commentId: input.commentId }
        : { postVersion: input.postVersion }),
      correlationId: input.correlationId,
    };
    const logPrefix = input.targetType === 'POST' ? 'post' : 'comment';
    const existing = await this.repository.find(input.eventId);
    if (existing) {
      if (
        existing.eventId !== input.eventId ||
        existing.postId !== input.postId ||
        (existing.targetType ?? 'COMMENT') !== input.targetType ||
        (input.targetType === 'POST'
          ? existing.postVersion !== input.postVersion
          : existing.commentId !== input.commentId) ||
        (existing.sourceHash && existing.sourceHash !== sourceHash)
      )
        throw new Error('Invalid conflicting moderation source event');
      // A saved result is not completion until its output publication is confirmed.
      await this.repository.save(existing);
      this.logger.success(
        `${logPrefix}_moderation_publication_confirmed`,
        'Stored moderation publication confirmed',
        context,
      );
      return existing;
    }
    const result = await this.provider.moderate(
      input.targetType === 'POST'
        ? `${input.title}\n\n${input.content}`
        : input.content,
    );
    const stored: StoredModerationResult = {
      ...result,
      eventId: input.eventId,
      postId: input.postId,
      moderatedAt: (now ?? new Date()).toISOString(),
      sourceHash,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      ...(input.targetType === 'POST'
        ? { targetType: 'POST', postVersion: input.postVersion }
        : {
            targetType: 'COMMENT',
            commentId: input.commentId,
            ...(input.activityVersion !== undefined
              ? { activityVersion: input.activityVersion }
              : {}),
          }),
    };
    await this.repository.save(stored);
    this.logger.success(
      `${logPrefix}_moderation_completed`,
      'Content moderation result persisted and published',
      context,
    );
    return (await this.repository.find(input.eventId)) ?? stored;
  }

  async republishExisting(eventId: string): Promise<void> {
    const result = await this.repository.find(eventId);
    if (result) {
      await this.repository.save(result);
      this.logger.success(
        `${result.targetType === 'POST' ? 'post' : 'comment'}_moderation_publication_confirmed`,
        'Stored moderation publication confirmed',
        {
          eventId,
          postId: result.postId,
          ...(result.targetType === 'POST'
            ? { postVersion: result.postVersion }
            : { commentId: result.commentId }),
        },
      );
    } else
      this.logger.skipped(
        'comment_moderation_republish_skipped',
        'RESULT_NOT_FOUND',
        { eventId },
      );
  }
}
