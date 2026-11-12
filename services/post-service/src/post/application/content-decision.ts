import type { PostUnitOfWork } from './ports.js';
import { event } from './event.js';

export type ContentDecision = {
  eventId: string;
  eventType: 'CONTENT_MODERATION_DECIDED';
  moderationDecisionId: string;
  sourceEventId: string;
  evaluationEventId: string;
  policyVersion: string;
  policyFingerprint: string;
  postId: string;
  occurredAt: Date;
  correlationId: string;
} & (
  | { targetType: 'POST'; postVersion: number }
  | { targetType: 'COMMENT'; commentId: string; activityVersion: number }
);
export type DecisionOutcome =
  | 'APPLIED'
  | 'STALE'
  | 'NOT_FOUND'
  | 'ALREADY_HIDDEN'
  | 'TERMINAL';
export class ApplyContentDecision {
  constructor(private readonly uow: PostUnitOfWork) {}
  async execute(input: ContentDecision): Promise<DecisionOutcome> {
    return this.uow.execute(async (tx) => {
      const post = await tx.queries.findPost(input.postId);
      const target =
        input.targetType === 'POST'
          ? post
          : await tx.queries.findComment(input.postId, input.commentId);
      const currentVersion =
        input.targetType === 'POST'
          ? post?.postVersion
          : target && 'activityVersion' in target
            ? target.activityVersion
            : 1;
      const expectedVersion =
        input.targetType === 'POST' ? input.postVersion : input.activityVersion;
      const outcome: DecisionOutcome =
        !post || !target
          ? 'NOT_FOUND'
          : target.status === 'HIDDEN'
            ? 'ALREADY_HIDDEN'
            : post.status !== 'ACTIVE' ||
                target.status !== 'ACTIVE' ||
                (post.expiresAt !== null && post.expiresAt <= new Date())
              ? 'TERMINAL'
              : currentVersion !== expectedVersion
                ? 'STALE'
                : 'APPLIED';
      const receipt = await tx.commands.recordContentDecision(input, outcome);
      if (!receipt.recorded) return receipt.outcome;
      const now = new Date();
      if (outcome === 'APPLIED' && post && target) {
        // The same transaction reads the version and writes the target; retries recheck edits.
        await tx.commands.fenceActivities(post.postId, post.bucketCount);
        if (input.targetType === 'POST') {
          await tx.commands.hidePost(post.postId, now, input.postVersion + 1);
          const hidden = event(
            post.postId,
            'PostHidden',
            {
              post: {
                postId: post.postId,
                authorId: post.authorId,
                category: post.category,
                hiddenAt: now,
              },
              postVersion: input.postVersion + 1,
              moderationDecisionId: input.moderationDecisionId,
            },
            now,
          );
          hidden.correlationId = input.correlationId;
          await tx.commands.appendEvent(hidden);
        } else {
          await tx.commands.hideComment(
            post.postId,
            input.commentId,
            now,
            input.activityVersion + 1,
          );
          await tx.commands.cancelVoteForComment(
            post.postId,
            input.commentId,
            now,
          );
          await tx.commands.increment(
            post.postId,
            'bucketId' in target ? (target.bucketId ?? 0) : 0,
            'commentCount',
            -1,
          );
          const hidden = event(
            post.postId,
            'PostCommentHidden',
            {
              comment: {
                postId: post.postId,
                commentId: input.commentId,
                authorId: target.authorId,
                hiddenAt: now,
              },
              activityVersion: input.activityVersion + 1,
              postAuthorId: post.authorId,
              moderationDecisionId: input.moderationDecisionId,
            },
            now,
          );
          hidden.correlationId = input.correlationId;
          await tx.commands.appendEvent(hidden);
        }
      }
      const result = event(
        input.postId,
        'ContentModerationApplied',
        {
          decision: {
            moderationDecisionId: input.moderationDecisionId,
            sourceEventId: input.eventId,
            targetType: input.targetType,
            postId: input.postId,
            ...(input.targetType === 'COMMENT'
              ? { commentId: input.commentId }
              : {}),
            reviewedVersion: expectedVersion,
            outcome,
            processedAt: now,
          },
        },
        now,
      );
      result.correlationId = input.correlationId;
      await tx.commands.appendEvent(result);
      return outcome;
    });
  }
}
