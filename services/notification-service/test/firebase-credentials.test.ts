import { ConfigService } from '@nestjs/config';
import { beforeEach, expect, it, vi } from 'vitest';
import { FirebasePushAdapter } from '../src/firebase/firebase-push.adapter.js';
import { PushSubscriptionService } from '../src/push-subscription/push-subscription.service.js';

const firebase = vi.hoisted(() => ({
  applicationDefault: vi.fn(() => ({ mode: 'adc' })),
  cert: vi.fn(() => ({ mode: 'explicit' })),
  initializeApp: vi.fn(() => ({})),
  send: vi.fn(),
}));
vi.mock('firebase-admin/app', () => ({
  applicationDefault: firebase.applicationDefault,
  cert: firebase.cert,
  getApps: () => [],
  initializeApp: firebase.initializeApp,
}));
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ sendEachForMulticast: firebase.send }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  firebase.send.mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true }],
  });
});
const subscriptions = new PushSubscriptionService({
  async list() {
    return [
      {
        userId: '1',
        token: 'device',
        platform: 'web',
        createdAt: '',
        updatedAt: '',
        lastSeenAt: '',
      },
    ];
  },
  async remove() {},
  async removeTokens() {},
  async upsert(input) {
    return input;
  },
});
it('sends with Workload Identity ADC when no long-lived key is configured', async () => {
  const adapter = new FirebasePushAdapter(
    new ConfigService({ firebase: { projectId: 'demo' } }),
    subscriptions,
  );
  expect(
    await adapter.send({ userId: '1', title: 'a', body: 'b' }),
  ).toMatchObject({ succeeded: 1 });
  expect(firebase.applicationDefault).toHaveBeenCalledOnce();
  expect(firebase.cert).not.toHaveBeenCalled();
  expect(firebase.initializeApp).toHaveBeenCalledWith({
    projectId: 'demo',
    credential: { mode: 'adc' },
  });
});
it('preserves complete explicit credentials and does not fall back from partial credentials', async () => {
  const adapter = new FirebasePushAdapter(
    new ConfigService({
      firebase: { projectId: 'demo', clientEmail: 'sender', privateKey: 'key' },
    }),
    subscriptions,
  );
  expect(
    await adapter.send({ userId: '1', title: 'a', body: 'b' }),
  ).toMatchObject({ succeeded: 1 });
  expect(firebase.cert).toHaveBeenCalledWith({
    projectId: 'demo',
    clientEmail: 'sender',
    privateKey: 'key',
  });
  expect(firebase.applicationDefault).not.toHaveBeenCalled();
  const partial = new FirebasePushAdapter(
    new ConfigService({
      firebase: { projectId: 'demo', clientEmail: 'sender' },
    }),
    subscriptions,
  );
  expect(
    await partial.send({ userId: '1', title: 'a', body: 'b' }),
  ).toMatchObject({ succeeded: 0, retryTokens: ['device'] });
  expect(firebase.applicationDefault).not.toHaveBeenCalled();
});
