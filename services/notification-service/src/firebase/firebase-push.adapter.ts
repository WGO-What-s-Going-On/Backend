import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import {
  getMessaging,
  type BatchResponse,
  type Messaging,
} from 'firebase-admin/messaging';

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
    @Optional()
    @Inject('FIREBASE_MESSAGING')
    messaging?: Messaging,
  ) {
    this.messaging = messaging;
  }

  async send(message: PushMessage): Promise<PushResult> {
    const subscriptions = await this.subscriptions.list(message.userId);
    const tokens = subscriptions
      .map((item) => item.token)
      .filter((token) => !message.tokens || message.tokens.includes(token));
    if (tokens.length === 0)
      return { attempted: 0, succeeded: 0, failed: 0, invalidTokens: [] };

    const data = {
      ...(message.data ?? {}),
      ...(message.targetId ? { targetId: message.targetId } : {}),
      ...(message.actionPath ? { actionPath: message.actionPath } : {}),
    };
    const invalidTokens: string[] = [];
    const retryTokens: string[] = [];
    const permanentTokens: string[] = [];
    let succeeded = 0;
    for (let offset = 0; offset < tokens.length; offset += 500) {
      const batch = tokens.slice(offset, offset + 500);
      let response: BatchResponse;
      try {
        response = await this.client().sendEachForMulticast({
          tokens: batch,
          notification: { title: message.title, body: message.body },
          data,
        });
      } catch {
        // 앞선 batch의 성공 token은 재전송하지 않는다. 응답을 잃은 batch만 재시도한다.
        retryTokens.push(...batch);
        continue;
      }
      succeeded += response.successCount;
      invalidTokens.push(...invalidFrom(response, batch));
      response.responses.forEach((item, index) => {
        const token = batch[index];
        if (
          item.success ||
          !token ||
          (item.error && INVALID_TOKEN_CODES.has(item.error.code))
        )
          return;
        if (
          item.error &&
          [
            'messaging/invalid-argument',
            'messaging/mismatched-credential',
            'messaging/invalid-package-name',
          ].includes(item.error.code)
        )
          permanentTokens.push(token);
        else retryTokens.push(token);
      });
    }
    // A failed cleanup only affects cache-like delivery state; the saved notification remains durable.
    try {
      await this.subscriptions.removeInvalid(message.userId, invalidTokens);
    } catch {
      retryTokens.push(...invalidTokens);
    }
    return {
      attempted: tokens.length,
      succeeded,
      failed: tokens.length - succeeded,
      invalidTokens,
      retryTokens,
      permanentTokens,
    };
  }

  private client(): Messaging {
    if (this.messaging) return this.messaging;
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = this.config
      .get<string>('firebase.privateKey')
      ?.replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey)
      throw new Error('Firebase credentials are not configured');
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
      });
    this.messaging = getMessaging(app);
    return this.messaging;
  }
}

function invalidFrom(response: BatchResponse, tokens: string[]): string[] {
  return response.responses.flatMap((item, index) =>
    !item.success &&
    item.error &&
    INVALID_TOKEN_CODES.has(item.error.code) &&
    tokens[index]
      ? [tokens[index]]
      : [],
  );
}
