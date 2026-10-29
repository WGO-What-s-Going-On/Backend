import { GatewayAuthGuard } from '../src/gateway-auth.js';
import type { ExecutionContext } from '@nestjs/common';
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
  it('rejects spoofable user headers in production at the gateway guard', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      new GatewayAuthGuard().canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-user-id': '1' },
            rawHeaders: ['x-user-id', '1'],
          }),
        }),
      } as ExecutionContext),
    ).toThrow('Invalid gateway identity');
  });
  it.each([undefined, '', '-1', '1.5', '__TOKEN_OWNER__', ['1']])(
    'rejects invalid development user header %s',
    (header) => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(() => controller().list(header)).toThrow('positive decimal');
    },
  );
});
