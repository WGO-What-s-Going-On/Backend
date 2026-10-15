import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, SystemClock, type Clock } from '../lifecycle/clock.js';

import { CommentModerationService } from '../content-moderation/comment-moderation.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import type { PostEvent } from './post-event.js';
import type { PostEventProcessor } from './post-event.processor.js';

@Injectable()
export class ModerationPostEventProcessor implements PostEventProcessor {
  constructor(
    private readonly moderation: CommentModerationService,
    private readonly lifecycle: LifecycleService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async process(event: PostEvent): Promise<void> {
    switch (event.eventType) {
      case 'PostCreated':
        await this.lifecycle.initialize(event.aggregateId, event.occurredAt);
        return;
      case 'PostCommentCreated':
        if (!event.comment?.content)
          throw new Error('Invalid PostCommentCreated payload');
        if (
          !(await this.lifecycle.canModerateComment(
            event.aggregateId,
            event.comment.commentId,
            event.activityVersion ?? 1,
          ))
        )
          return;
        await this.moderation.moderate({
          eventId: event.eventId,
          postId: event.aggregateId,
          commentId: event.comment.commentId,
          content: event.comment.content,
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
}
