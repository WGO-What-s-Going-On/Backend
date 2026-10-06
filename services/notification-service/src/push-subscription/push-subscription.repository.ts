import type { PushSubscription } from './push-subscription.js';

export const PUSH_SUBSCRIPTION_REPOSITORY = Symbol('PUSH_SUBSCRIPTION_REPOSITORY');

export interface PushSubscriptionRepository {
  upsert(subscription: PushSubscription): Promise<PushSubscription>;
  remove(userId: string, token: string): Promise<void>;
  list(userId: string): Promise<PushSubscription[]>;
  removeTokens(userId: string, tokens: string[]): Promise<void>;
}
