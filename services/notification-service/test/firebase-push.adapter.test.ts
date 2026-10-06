import { ConfigService } from '@nestjs/config';
import type { BatchResponse, Messaging } from 'firebase-admin/messaging';
import { describe, expect, it, vi } from 'vitest';

import { FirebasePushAdapter } from '../src/firebase/firebase-push.adapter.js';
import type { PushSubscriptionRepository } from '../src/push-subscription/push-subscription.repository.js';
import { PushSubscriptionService } from '../src/push-subscription/push-subscription.service.js';
import type { PushSubscription } from '../src/push-subscription/push-subscription.js';

class MemorySubscriptions implements PushSubscriptionRepository {
  items: PushSubscription[] = [];
  async upsert(value: PushSubscription) { this.items.push(value); return value; }
  async remove(userId: string, token: string) { this.items = this.items.filter((item) => item.userId !== userId || item.token !== token); }
  async list(userId: string) { return this.items.filter((item) => item.userId === userId); }
  async removeTokens(userId: string, tokens: string[]) { this.items = this.items.filter((item) => item.userId !== userId || !tokens.includes(item.token)); }
}

describe('FirebasePushAdapter', () => {
  it('sends routing data to all registered tokens', async () => {
    const repository = new MemorySubscriptions();
    const subscriptions = new PushSubscriptionService(repository);
    await subscriptions.upsert('1', 'a', 'android');
    await subscriptions.upsert('1', 'b', 'ios');
    const sendEachForMulticast = vi.fn().mockResolvedValue({ successCount: 2, failureCount: 0, responses: [{ success: true }, { success: true }] } satisfies BatchResponse);
    const adapter = new FirebasePushAdapter(new ConfigService(), subscriptions, { sendEachForMulticast } as unknown as Messaging);
    await expect(adapter.send({ userId: '1', title: 'title', body: 'body', targetId: 'post-1', actionPath: '/posts/post-1' })).resolves.toMatchObject({ succeeded: 2, failed: 0 });
    expect(sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({ tokens: ['a', 'b'], data: { targetId: 'post-1', actionPath: '/posts/post-1' } }));
  });

  it('reports partial failures and removes only invalid tokens', async () => {
    const repository = new MemorySubscriptions();
    const subscriptions = new PushSubscriptionService(repository);
    await subscriptions.upsert('1', 'valid', 'android');
    await subscriptions.upsert('1', 'invalid', 'android');
    const sendEachForMulticast = vi.fn().mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } }],
    } as unknown as BatchResponse);
    const adapter = new FirebasePushAdapter(new ConfigService(), subscriptions, { sendEachForMulticast } as unknown as Messaging);
    await expect(adapter.send({ userId: '1', title: 'title', body: 'body' })).resolves.toMatchObject({ failed: 1, invalidTokens: ['invalid'] });
    expect(repository.items.map((item) => item.token)).toEqual(['valid']);
  });
});
