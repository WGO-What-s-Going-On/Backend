export type PushPlatform = 'android' | 'ios' | 'web';

export interface PushSubscription {
  userId: string;
  token: string;
  platform: PushPlatform;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}
