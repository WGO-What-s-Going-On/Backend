import {
  InvalidPostError,
  PostNotFoundError,
  PostOwnershipError,
  requireActive,
} from '../domain/post.js';
import { event } from './event.js';
import type { PartitionStrategy } from './partition.js';
import type { PostTransaction, PostUnitOfWork } from './ports.js';

async function existingPost(transaction: PostTransaction, postId: string) {
  const post = await transaction.queries.findPost(postId);
  if (!post) throw new PostNotFoundError('Post not found');
  return post;
}

type Deletion =
  | { actor: { type: 'USER'; userId: number }; reason: 'USER_REQUEST' }
  | {
      actor: { type: 'MODERATION'; userId: null };
      reason: 'MODERATION_VIOLATION';
      moderationDecisionId: string;
    };

export class PostLifecycle {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly partition: PartitionStrategy,
  ) {}

  async removeReaction(postId: string, userId: number): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      const reaction = await tx.queries.findReaction(postId, userId);
      // 취소는 게시물 비활성화 후에도 허용한다. 없는 공감 관계를 새로 만들지 않는다.
      if (!reaction || reaction.removedAt) return;
      const now = new Date();
      const activityVersion = (reaction.activityVersion ?? 1) + 1;
      await tx.commands.removeReaction(postId, userId, now, activityVersion);
      await tx.commands.increment(
        postId,
        reaction.bucketId ?? 0,
        'reactionCount',
        -1,
      );
      await tx.commands.appendEvent(
        event(
          postId,
          'PostReactionRemoved',
          {
            reaction: {
              postId,
              userId,
              type: reaction.type,
              createdAt: reaction.createdAt,
              removedAt: now,
            },
            postAuthorId: post.authorId,
            postCategory: post.category,
            activityVersion,
          },
          now,
        ),
      );
    });
  }

  async deleteComment(
    postId: string,
    commentId: string,
    userId: number,
  ): Promise<void> {
    await this.deleteCommentWithReason(postId, commentId, {
      actor: { type: 'USER', userId },
      reason: 'USER_REQUEST',
    });
  }

  async moderateComment(
    postId: string,
    commentId: string,
    moderationDecisionId: string,
  ): Promise<void> {
    this.validateDecision(moderationDecisionId);
    await this.deleteCommentWithReason(postId, commentId, {
      actor: { type: 'MODERATION', userId: null },
      reason: 'MODERATION_VIOLATION',
      moderationDecisionId,
    });
  }

  private async deleteCommentWithReason(
    postId: string,
    commentId: string,
    deletion: Deletion,
  ): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      const comment = await tx.queries.findComment(postId, commentId);
      if (!comment) throw new PostNotFoundError('Comment not found');
      if (
        deletion.actor.type === 'USER' &&
        comment.authorId !== deletion.actor.userId
      )
        throw new PostOwnershipError('Only the comment author can delete it');
      if (comment.status === 'DELETED') return;
      const now = new Date();
      const activityVersion = (comment.activityVersion ?? 1) + 1;
      await tx.commands.deleteComment(postId, commentId, now, activityVersion);
      await tx.commands.increment(
        postId,
        comment.bucketId ?? 0,
        'commentCount',
        -1,
      );
      await tx.commands.appendEvent(
        event(
          postId,
          'PostCommentDeleted',
          {
            comment: {
              commentId,
              postId,
              authorId: comment.authorId,
              deletedAt: now,
            },
            postAuthorId: post.authorId,
            postCategory: post.category,
            activityVersion,
            ...deletion,
          },
          now,
        ),
      );
    });
  }

  async leave(postId: string, userId: number): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      const participant = await tx.queries.findParticipant(postId, userId);
      if (!participant || participant.leftAt) return;
      const now = new Date();
      const activityVersion = (participant.activityVersion ?? 1) + 1;
      await tx.commands.leaveParticipant(postId, userId, now, activityVersion);
      await tx.commands.increment(
        postId,
        this.partition.resolveBucket(String(userId), post.bucketCount),
        'participantCount',
        -1,
      );
      await tx.commands.appendEvent(
        event(
          postId,
          'PostParticipantLeft',
          {
            participant: {
              postId,
              userId,
              joinedAt: participant.joinedAt,
              leftAt: now,
            },
            postAuthorId: post.authorId,
            postCategory: post.category,
            activityVersion,
          },
          now,
        ),
      );
    });
  }

  async deletePost(postId: string, userId: number): Promise<void> {
    await this.deletePostWithReason(postId, {
      actor: { type: 'USER', userId },
      reason: 'USER_REQUEST',
    });
  }

  async moderatePost(
    postId: string,
    moderationDecisionId: string,
  ): Promise<void> {
    this.validateDecision(moderationDecisionId);
    await this.deletePostWithReason(postId, {
      actor: { type: 'MODERATION', userId: null },
      reason: 'MODERATION_VIOLATION',
      moderationDecisionId,
    });
  }

  private validateDecision(value: string): void {
    if (!value.trim() || value.length > 128)
      throw new InvalidPostError('Valid moderation decision ID required');
  }

  private async deletePostWithReason(
    postId: string,
    deletion: Deletion,
  ): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      if (
        deletion.actor.type === 'USER' &&
        post.authorId !== deletion.actor.userId
      )
        throw new PostOwnershipError('Only the post author can delete it');
      if (post.status === 'DELETED') return;
      const now = new Date();
      const postVersion = post.postVersion + 1;
      await tx.commands.fenceActivities(postId, post.bucketCount);
      await tx.commands.changePostStatus(postId, 'DELETED', now, postVersion);
      // 하위 활동을 대량 삭제하거나 가짜 취소 이벤트를 만들지 않는다. 소비자는 postId로 무효화한다.
      await tx.commands.appendEvent(
        event(
          postId,
          'PostDeleted',
          {
            post: {
              postId,
              authorId: post.authorId,
              category: post.category,
              deletedAt: now,
            },
            postVersion,
            ...deletion,
          },
          now,
        ),
      );
    });
  }

  async scheduleExpiration(postId: string, expiresAt: Date): Promise<void> {
    if (!Number.isFinite(expiresAt.getTime()))
      throw new InvalidPostError('Invalid expiration date');
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      if (post.expiresAt?.getTime() === expiresAt.getTime()) return;
      requireActive(post);
      await tx.commands.fenceActivities(postId, post.bucketCount);
      await tx.commands.scheduleExpiration(postId, expiresAt, new Date());
    });
  }

  async expire(postId: string): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      const post = await existingPost(tx, postId);
      const now = new Date();
      // 스캔 이후 기한 변경·삭제가 가능하므로 트랜잭션 안에서 만료 조건을 다시 확인한다.
      if (post.status !== 'ACTIVE' || !post.expiresAt || post.expiresAt > now)
        return;
      const postVersion = post.postVersion + 1;
      await tx.commands.fenceActivities(postId, post.bucketCount);
      await tx.commands.changePostStatus(postId, 'EXPIRED', now, postVersion);
      await tx.commands.appendEvent(
        event(
          postId,
          'PostExpired',
          {
            post: {
              postId,
              authorId: post.authorId,
              category: post.category,
              expiresAt: post.expiresAt,
              expiredAt: now,
            },
            postVersion,
          },
          now,
        ),
      );
    });
  }
}
