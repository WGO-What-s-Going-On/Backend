import { Inject, Injectable } from '@nestjs/common';

import type { PushSender } from '../firebase/push.js';
import { PUSH_SENDER } from '../firebase/push.js';
import { NotificationService } from '../notification/notification.service.js';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepository,
} from '../notification/notification.repository.js';
import { NotificationState } from '../redis/notification-state.js';
import {
  RECIPIENT_RESOLVER,
  type RecipientResolver,
} from './recipient-resolver.js';
import type { PostEvent } from './post-event.js';

@Injectable()
export class PostEventHandler {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    private readonly state: NotificationState,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Inject(RECIPIENT_RESOLVER) private readonly recipients: RecipientResolver,
  ) {}

  async handle(event: PostEvent): Promise<void> {
    if (
      !['PostCommentCreated', 'PostReactionCreated'].includes(event.eventType)
    )
      return;
    const recipient = await this.recipients.postAuthor(event.aggregateId);
    if (!recipient || recipient === event.actorId) return;
    if (!(await this.state.claim(event.eventId, recipient))) return;

    try {
      const type =
        event.eventType === 'PostCommentCreated'
          ? 'POST_COMMENTED'
          : 'POST_LIKED';
      const title =
        event.eventType === 'PostCommentCreated' ? '새 댓글' : '새 좋아요';
      const candidateId = `${event.occurredAt}_${event.eventId}_${recipient}`;
      const notificationId = await this.state.reserveBundle(
        recipient,
        event.aggregateId,
        type,
        candidateId,
      );
      if (notificationId !== candidateId) {
        await this.repository.increment(recipient, notificationId);
        await this.state.complete(event.eventId, recipient);
        return;
      }
      const notification = await this.notifications.create(
        {
          userId: recipient,
          actorId: event.actorId ?? null,
          type,
          title,
          body:
            event.eventType === 'PostCommentCreated'
              ? '게시물에 새 댓글이 달렸습니다.'
              : '게시물에 좋아요가 추가되었습니다.',
          targetType: 'post',
          targetId: event.aggregateId,
          actionPath: `/posts/${event.aggregateId}`,
        },
        new Date(event.occurredAt),
        candidateId,
      );
      if (!notification) {
        await this.state.complete(event.eventId, recipient);
        return;
      }
      // Push failure never rolls back the notification already saved in DynamoDB.
      await this.push.send({
        userId: recipient,
        title: notification.title,
        body: notification.body,
        targetId: notification.targetId,
        actionPath: notification.actionPath,
        data: {
          notificationId: notification.notificationId,
          type: notification.type,
        },
      });
      await this.state.complete(event.eventId, recipient);
    } catch (error) {
      await this.state.release(event.eventId, recipient);
      throw error;
    }
  }
}
