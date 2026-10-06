import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type BatchResponse, type Messaging } from 'firebase-admin/messaging';

import type { PushMessage, PushResult, PushSender } from './push.js';
import { PushSubscriptionService } from '../push-subscription/push-subscription.service.js';

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

@Injectable()
export class FirebasePushAdapter implements PushSender {
  private messaging: Messaging | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly subscriptions: PushSubscriptionService,
    @Optional() @Inject('FIREBASE_MESSAGING')
    messaging?: Messaging,
  ) {
    this.messaging = messaging;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const subscriptions = await this.subscriptions.list(message.userId);
    const tokens = subscriptions.map((item) => item.token);
    if (tokens.length === 0) return { attempted: 0, succeeded: 0, failed: 0, invalidTokens: [] };

    const data = {
      ...(message.data ?? {}),
      ...(message.targetId ? { targetId: message.targetId } : {}),
      ...(message.actionPath ? { actionPath: message.actionPath } : {}),
    };
    const response = await this.client().sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data,
    });
    const invalidTokens = invalidFrom(response, tokens);
    // A failed cleanup only affects cache-like delivery state; the saved notification remains durable.
    await this.subscriptions.removeInvalid(message.userId, invalidTokens);
    return {
      attempted: tokens.length,
      succeeded: response.successCount,
      failed: response.failureCount,
      invalidTokens,
    };
  }

  private client(): Messaging {
    if (this.messaging) return this.messaging;
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = this.config.get<string>('firebase.privateKey')?.replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase credentials are not configured');
    const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    this.messaging = getMessaging(app);
    return this.messaging;
  }
}

function invalidFrom(response: BatchResponse, tokens: string[]): string[] {
  return response.responses.flatMap((item, index) =>
    !item.success && item.error && INVALID_TOKEN_CODES.has(item.error.code) && tokens[index]
      ? [tokens[index]]
      : [],
  );
}
