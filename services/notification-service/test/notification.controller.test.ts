import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationController } from '../src/notification/notification.controller.js';
import type { NotificationService } from '../src/notification/notification.service.js';
import type { PushSubscriptionService } from '../src/push-subscription/push-subscription.service.js';
describe('Notification user context', () => {
  afterEach(() => vi.unstubAllEnvs());
  const list = vi.fn();
  const controller = () =>
    new NotificationController(
      { list } as unknown as NotificationService,
      {} as PushSubscriptionService,
    );
  it('rejects spoofable user headers in production until authentication is integrated', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => controller().list('1')).toThrow(
      'authentication integration is unavailable',
    );
  });
  it.each([undefined, '', '-1', '1.5', '__TOKEN_OWNER__', ['1']])(
    'rejects invalid development user header %s',
    (header) => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(() => controller().list(header)).toThrow('positive decimal');
    },
  );
});
