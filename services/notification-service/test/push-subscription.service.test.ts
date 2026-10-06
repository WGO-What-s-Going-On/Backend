import { describe, expect, it } from 'vitest';

import type { PushSubscriptionRepository } from '../src/push-subscription/push-subscription.repository.js';
import { PushSubscriptionService } from '../src/push-subscription/push-subscription.service.js';
import type { PushSubscription } from '../src/push-subscription/push-subscription.js';

class MemorySubscriptions implements PushSubscriptionRepository {
  items: PushSubscription[] = [];
  async upsert(value: PushSubscription) {
    this.items = this.items.filter((item) => item.userId !== value.userId || item.token !== value.token);
    this.items.push(value);
    return value;
  }
  async remove(userId: string, token: string) { this.items = this.items.filter((item) => item.userId !== userId || item.token !== token); }
  async list(userId: string) { return this.items.filter((item) => item.userId === userId); }
  async removeTokens(userId: string, tokens: string[]) { this.items = this.items.filter((item) => item.userId !== userId || !tokens.includes(item.token)); }
}

describe('PushSubscriptionService', () => {
  it('upserts and refreshes a token while preserving createdAt', async () => {
    const repository = new MemorySubscriptions();
    const service = new PushSubscriptionService(repository);
    const first = await service.upsert('1', 'token', 'android', new Date('2026-01-01'));
    const refreshed = await service.upsert('1', 'token', 'ios', new Date('2026-01-02'));
    expect(repository.items).toHaveLength(1);
    expect(refreshed).toMatchObject({ platform: 'ios', createdAt: first.createdAt, lastSeenAt: new Date('2026-01-02').toISOString() });
  });

  it('deletes only the owners token', async () => {
    const repository = new MemorySubscriptions();
    const service = new PushSubscriptionService(repository);
    await service.upsert('1', 'shared', 'android');
    await service.upsert('2', 'shared', 'android');
    await service.remove('1', 'shared');
    expect(repository.items.map((item) => item.userId)).toEqual(['2']);
  });
});
