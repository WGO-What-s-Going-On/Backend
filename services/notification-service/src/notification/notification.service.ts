import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { CreateNotificationInput, Notification, NotificationPage } from './notification.js';
import { NOTIFICATION_REPOSITORY, type NotificationRepository } from './notification.repository.js';
import { NotificationState } from '../redis/notification-state.js';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Optional() private readonly state?: NotificationState,
  ) {}

  async create(input: CreateNotificationInput, now = new Date(), notificationId?: string): Promise<Notification | null> {
    if (input.actorId !== undefined && input.actorId === input.userId) return null;
    const createdAt = now.toISOString();
    const notification: Notification = {
      notificationId: notificationId ?? `${createdAt}_${randomUUID()}`,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      actionPath: input.actionPath ?? null,
      count: 1,
      isRead: false,
      createdAt,
      expiresAt: Math.floor(now.getTime() / 1000) + THIRTY_DAYS_SECONDS,
    };
    const created = await this.repository.create(notification);
    if (created) await this.state?.incrementUnread(input.userId);
    return notification;
  }

  list(userId: string, limit = 20, cursor?: string): Promise<NotificationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
    return this.repository.list(userId, limit, cursor);
  }

  async markRead(userId: string, notificationId: string): Promise<Notification | null> {
    const notification = await this.repository.markRead(userId, notificationId);
    if (notification) await this.state?.decrementUnread(userId);
    return notification;
  }

  unread(userId: string): Promise<number> {
    if (!this.state) return this.repository.countUnread(userId);
    return this.state.unread(userId, () => this.repository.countUnread(userId));
  }
}
