import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, SystemClock, type Clock } from '../lifecycle/clock.js';

import { ContentModerationService } from '../content-moderation/content-moderation.service.js';
import { ContentEnforcementService } from '../content-moderation/content-enforcement.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import type { PostEvent, PostContentSnapshot } from './post-event.js';
import type { PostEventProcessor } from './post-event.processor.js';

@Injectable()
export class ModerationPostEventProcessor implements PostEventProcessor {
  constructor(
    private readonly moderation: ContentModerationService,
    private readonly lifecycle: LifecycleService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional() private readonly enforcement?: ContentEnforcementService,
  ) {}

  async process(event: PostEvent): Promise<void> {
    switch (event.eventType) {
      case 'PostCreated':
        if (event.post?.authorId)
          await this.lifecycle.initialize(
            event.aggregateId,
            event.occurredAt,
            String(event.post.authorId),
          );
        else
          await this.lifecycle.initialize(event.aggregateId, event.occurredAt);
        if (event.postContent)
          await this.moderatePost(event, event.postContent);
        return;
      case 'PostUpdated':
        if (event.postContent)
          await this.moderatePost(event, event.postContent);
        return;
      case 'PostCommentCreated':
      case 'PostCommentUpdated':
        if (!event.comment?.content)
          throw new Error('Invalid PostCommentCreated payload');
        await this.enforcement?.observeComment(event.aggregateId, event.comment.commentId, event.activityVersion ?? 1);
        if (
          !(await this.lifecycle.canModerateComment(
            event.aggregateId,
            event.comment.commentId,
            event.activityVersion ?? 1,
          ))
        ) {
          // Deletion/duplicate activity must not strand an already computed result.
          await this.moderation.republishExisting(event.eventId);
          return;
        }
        await this.moderation.moderate({
          targetType: 'COMMENT',
          eventId: event.eventId,
          postId: event.aggregateId,
          commentId: event.comment.commentId,
          content: event.comment.content,
          correlationId: event.correlationId,
          authorId: event.comment.authorId,
          activityVersion: event.activityVersion ?? 1,
        });
        await this.lifecycle.recordComment(
          event.aggregateId,
          event.comment.commentId,
          event.activityVersion ?? 1,
          false,
          event.occurredAt,
          event.correlationId,
        );
        return;
      case 'PostReactionCreated':
      case 'PostReactionRemoved':
        if (!event.reaction) throw new Error('Invalid reaction payload');
        await this.lifecycle.recordReaction(
          event.aggregateId,
          {
            userId: event.reaction.userId,
            type: event.reaction.type,
            createdAt: event.reaction.createdAt,
            version: event.activityVersion ?? 1,
            active: event.eventType === 'PostReactionCreated',
          },
          event.occurredAt,
          event.correlationId,
          this.clock.now(),
        );
        return;
      case 'PostCommentDeleted':
        if (!event.comment)
          throw new Error('Invalid PostCommentDeleted payload');
        await this.enforcement?.observeComment(event.aggregateId, event.comment.commentId, event.activityVersion!, true);
        await this.lifecycle.recordComment(
          event.aggregateId,
          event.comment.commentId,
          event.activityVersion!,
          true,
          event.occurredAt,
          event.correlationId,
        );
        return;
      case 'PostDeleted':
      case 'PostExpired':
        await this.enforcement?.observePostTerminal(event.aggregateId);
        await this.lifecycle.terminate(
          event.aggregateId,
          event.eventType === 'PostDeleted' ? 'DELETED' : 'EXPIRED',
          event.postVersion!,
          event.occurredAt,
          event.correlationId,
        );
        return;
      case 'PostParticipantJoined':
      case 'PostParticipantLeft':
        return;
    }
  }
  private async moderatePost(
    event: PostEvent,
    snapshot: PostContentSnapshot,
  ): Promise<void> {
    await this.moderation.moderate({
      targetType: 'POST',
      eventId: event.eventId,
      postId: event.aggregateId,
      correlationId: event.correlationId,
      ...snapshot,
    });
  }
}
