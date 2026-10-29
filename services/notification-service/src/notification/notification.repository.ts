import type { Notification, NotificationPage } from './notification.js';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface NotificationRepository {
  remove?(userId: string, notificationId: string): Promise<void>;
  create(notification: Notification): Promise<boolean>;
  list(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage>;
  markRead(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null>;
  increment(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null>;
  countUnread(userId: string): Promise<number>;
}
