import { Injectable } from '@nestjs/common';

import { CommentModerationService } from '../content-moderation/comment-moderation.service.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import type { PostEvent } from './post-event.js';
import type { PostEventProcessor } from './post-event.processor.js';

@Injectable()
export class ModerationPostEventProcessor implements PostEventProcessor {
  constructor(
    private readonly moderation: CommentModerationService,
    private readonly lifecycle: LifecycleService,
  ) {}

  async process(event: PostEvent): Promise<void> {
    switch (event.eventType) {
      case 'PostCreated':
        await this.lifecycle.initialize(event.aggregateId, event.occurredAt);
        return;
      case 'PostCommentCreated':
        if (!event.comment)
          throw new Error('Invalid PostCommentCreated payload');
        await this.moderation.moderate({
          eventId: event.eventId,
          postId: event.aggregateId,
          commentId: event.comment.commentId,
          content: event.comment.content,
        });
        await this.lifecycle.recordActivity(
          event.aggregateId,
          event.occurredAt,
          event.correlationId,
        );
        return;
      case 'PostReactionCreated':
      case 'PostParticipantJoined':
        return;
    }
  }
}
