import { Inject, Injectable } from '@nestjs/common';

import { PUSH_SUBSCRIPTION_REPOSITORY, type PushSubscriptionRepository } from './push-subscription.repository.js';
import type { PushPlatform, PushSubscription } from './push-subscription.js';

@Injectable()
export class PushSubscriptionService {
  constructor(
    @Inject(PUSH_SUBSCRIPTION_REPOSITORY)
    private readonly repository: PushSubscriptionRepository,
  ) {}

  async upsert(userId: string, token: string, platform: PushPlatform, now = new Date()): Promise<PushSubscription> {
    if (!token.trim()) throw new Error('token is required');
    if (!['android', 'ios', 'web'].includes(platform)) throw new Error('unsupported platform');
    const existing = (await this.repository.list(userId)).find((item) => item.token === token);
    const timestamp = now.toISOString();
    return this.repository.upsert({
      userId,
      token,
      platform,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    });
  }

  remove(userId: string, token: string): Promise<void> {
    return this.repository.remove(userId, token);
  }

  list(userId: string): Promise<PushSubscription[]> {
    return this.repository.list(userId);
  }

  removeInvalid(userId: string, tokens: string[]): Promise<void> {
    return this.repository.removeTokens(userId, tokens);
  }
}
