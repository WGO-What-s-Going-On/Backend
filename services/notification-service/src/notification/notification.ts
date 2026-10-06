export interface Notification {
  notificationId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  actionPath: string | null;
  count: number;
  isRead: boolean;
  createdAt: string;
  expiresAt: number;
}

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  actionPath?: string | null;
}

export interface NotificationPage {
  items: Notification[];
  nextCursor?: string;
}
