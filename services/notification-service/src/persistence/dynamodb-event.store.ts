import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { DYNAMODB_DOCUMENT_CLIENT } from './dynamodb.client.js';
import type { PostEvent } from '../event-consumer/post-event.js';
import type { Notification } from '../notification/notification.js';
import type { PushMessage } from '../firebase/push.js';

interface Meta {
  revision: number;
  authorId?: string;
  closed?: boolean;
  postVersion?: number;
  terminalType?: string;
}
interface Activity {
  version: number;
  active: boolean;
  notificationId?: string;
  recipient?: string;
  terminal?: boolean;
}
interface Window {
  notificationId: string;
  until: number;
}
export interface Delivery {
  postId: string;
  key: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'CANCELED' | 'FAILED';
  message: PushMessage;
  leaseId?: string;
  leaseUntil?: number;
  nextAttemptAt?: number;
  attempts: number;
}
type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>;
export class BusyDeliveryError extends Error {
  constructor() {
    super('Delivery is busy; keep event pending');
  }
}

@Injectable()
export class DynamoDbEventStore {
  private readonly table: string;
  private readonly notificationsTable: string;
  constructor(
    @Inject(DYNAMODB_DOCUMENT_CLIENT)
    private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    this.table =
      config.get<string>('dynamodb.eventStateTable') ??
      'notification-event-state';
    this.notificationsTable =
      config.get<string>('dynamodb.notificationsTable') ?? 'notifications';
  }

  async get<T>(postId: string, key: string): Promise<T | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { postId, key },
        ConsistentRead: true,
      }),
    );
    return result.Item as T | undefined;
  }

  private put(postId: string, key: string, item: object): Writes[number] {
    return { Put: { TableName: this.table, Item: { ...item, postId, key } } };
  }

  async preferences(userId: string) {
    const value = await this.get<{
      nearby?: boolean;
      replies?: boolean;
      reactions?: boolean;
      lifecycle?: boolean;
    }>(`USER#${userId}`, 'PREFERENCES');
    return {
      nearby: value?.nearby ?? true,
      replies: value?.replies ?? true,
      reactions: value?.reactions ?? true,
      lifecycle: value?.lifecycle ?? true,
    };
  }
  async savePreferences(userId: string, input: Record<string, boolean>) {
    const names = Object.keys(input);
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { postId: `USER#${userId}`, key: 'PREFERENCES' },
        UpdateExpression:
          'SET ' + names.map((_, i) => `#k${i} = :v${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(
          names.map((name, i) => [`#k${i}`, name]),
        ),
        ExpressionAttributeValues: Object.fromEntries(
          names.map((name, i) => [`:v${i}`, input[name]]),
        ),
      }),
    );
    return this.preferences(userId);
  }
  async boardPreference(userId: string, postId: string) {
    const value = await this.get<{ enabled: boolean }>(
      `USER#${userId}`,
      `BOARD#${postId}`,
    );
    return { postId, enabled: value?.enabled ?? true };
  }
  async setBoardPreference(userId: string, postId: string, enabled: boolean) {
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { postId: `USER#${userId}`, key: `BOARD#${postId}`, enabled },
      }),
    );
    return { postId, enabled };
  }
  async allowed(userId: string, postId: string, type: string) {
    const [preferences, board] = await Promise.all([
      this.preferences(userId),
      this.boardPreference(userId, postId),
    ]);
    const key =
      type === 'PostCommentCreated' || type === 'POST_COMMENTED'
        ? 'replies'
        : type === 'PostReactionCreated' || type === 'POST_REACTED'
          ? 'reactions'
          : type === 'POST_CREATED'
            ? 'nearby'
            : 'lifecycle';
    return board.enabled && preferences[key];
  }

  async apply(event: PostEvent, now = new Date()): Promise<string | undefined> {
    const postId = event.aggregateId;
    for (let attempt = 0; attempt < 8; attempt++) {
      const processed = await this.get<{ recipient?: string }>(
        postId,
        `event#${event.eventId}`,
      );
      if (processed) return processed.recipient;
      const current = await this.get<Meta>(postId, 'meta');
      const meta: Meta = { ...current, revision: (current?.revision ?? 0) + 1 };
      if (event.postAuthorId) meta.authorId = event.postAuthorId;
      const recipient = event.postAuthorId ?? meta.authorId;
      const writes: Writes = [];
      const marker = {
        recipient,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        reason: event.reason,
        actorType: event.actorType,
      };
      const terminal =
        event.eventType === 'PostDeleted' || event.eventType === 'PostExpired';
      if (terminal) {
        // 한번 삭제/만료된 post는 늦은 PostCreated로 다시 열지 않는다.
        meta.closed = true;
        if ((event.postVersion ?? 0) >= (meta.postVersion ?? 0)) {
          meta.postVersion = event.postVersion ?? 1;
          meta.terminalType = event.eventType;
        }
      } else if (
        event.eventType === 'PostCreated' &&
        event.postVersion !== undefined
      ) {
        meta.postVersion = Math.max(meta.postVersion ?? 0, event.postVersion);
      }
      if (event.activityKey && !meta.closed) {
        const key = `activity#${event.activityKey}`;
        const previous = await this.get<Activity>(postId, key);
        const version = event.activityVersion ?? 1;
        const active =
          event.eventType === 'PostCommentCreated' ||
          event.eventType === 'PostReactionCreated';
        if (!previous || (version > previous.version && !previous.terminal)) {
          const activity: Activity = {
            version,
            active,
            ...(event.eventType === 'PostCommentDeleted'
              ? { terminal: true }
              : {}),
          };
          if (
            active &&
            recipient !== event.actorId &&
            (!recipient ||
              (await this.allowed(recipient, postId, event.eventType)))
          ) {
            if (!recipient)
              throw new Error(
                'Legacy post author unavailable; recipient reconciliation required',
              );
            const type =
              event.eventType === 'PostCommentCreated'
                ? 'POST_COMMENTED'
                : 'POST_REACTED';
            const windowKey = `window#${recipient}#${type}`;
            const window = await this.get<Window>(postId, windowKey);
            let existing: Notification | undefined;
            if (window && window.until > now.getTime()) {
              const result = await this.client.send(
                new GetCommand({
                  TableName: this.notificationsTable,
                  Key: {
                    userId: recipient,
                    notificationId: window.notificationId,
                  },
                  ConsistentRead: true,
                }),
              );
              existing = result.Item as Notification | undefined;
              if (
                existing &&
                (existing.count === 0 ||
                  existing.expiresAt <= now.getTime() / 1000)
              )
                existing = undefined;
            }
            if (existing) {
              activity.notificationId = existing.notificationId;
              writes.push({
                Update: {
                  TableName: this.notificationsTable,
                  Key: {
                    userId: recipient,
                    notificationId: existing.notificationId,
                  },
                  UpdateExpression: 'ADD #count :one',
                  ConditionExpression: 'attribute_exists(notificationId)',
                  ExpressionAttributeNames: { '#count': 'count' },
                  ExpressionAttributeValues: { ':one': 1 },
                },
              });
            } else {
              const notificationId = `${now.toISOString()}_${event.eventId}_${recipient}`;
              activity.notificationId = notificationId;
              const notification: Notification = {
                notificationId,
                userId: recipient,
                type,
                title: type === 'POST_COMMENTED' ? '새 댓글' : '새 공감',
                body:
                  type === 'POST_COMMENTED'
                    ? '게시물에 새 댓글이 달렸습니다.'
                    : '게시물에 새로운 반응이 있습니다.',
                actorId: event.actorId ?? null,
                targetType: 'post',
                targetId: postId,
                actionPath: `/posts/${postId}`,
                count: 1,
                isRead: false,
                createdAt: now.toISOString(),
                expiresAt: Math.floor(now.getTime() / 1000) + 2_592_000,
                ...(event.commentId ? { commentId: event.commentId } : {}),
              };
              writes.push({
                Put: {
                  TableName: this.notificationsTable,
                  Item: notification,
                  ConditionExpression: 'attribute_not_exists(notificationId)',
                },
              });
              writes.push(
                this.put(postId, windowKey, {
                  notificationId,
                  until: now.getTime() + 120_000,
                }),
              );
              writes.push(
                this.put(postId, `delivery#${notificationId}`, {
                  status: 'PENDING',
                  attempts: 0,
                  message: {
                    userId: recipient,
                    title: notification.title,
                    body: notification.body,
                    targetId: postId,
                    actionPath: notification.actionPath,
                    data: {
                      notificationId,
                      type,
                      ...(event.commentId
                        ? { commentId: event.commentId }
                        : {}),
                    },
                  },
                }),
              );
            }
            activity.recipient = recipient;
          } else if (
            !active &&
            previous?.active &&
            previous.notificationId &&
            previous.recipient
          ) {
            // 생성·취소가 역순이면 앞선 tombstone 때문에 생성은 집계되지 않는다.
            const notification = await this.client.send(
              new GetCommand({
                TableName: this.notificationsTable,
                Key: {
                  userId: previous.recipient,
                  notificationId: previous.notificationId,
                },
                ConsistentRead: true,
              }),
            );
            const removedReference =
              !!event.commentId &&
              notification.Item?.commentId === event.commentId;
            if (notification.Item && Number(notification.Item.count) > 0)
              writes.push({
                Update: {
                  TableName: this.notificationsTable,
                  Key: {
                    userId: previous.recipient,
                    notificationId: previous.notificationId,
                  },
                  UpdateExpression: `ADD #count :minus${removedReference ? ' REMOVE commentId' : ''}`,
                  ConditionExpression:
                    'attribute_exists(notificationId) AND #count > :zero',
                  ExpressionAttributeNames: { '#count': 'count' },
                  ExpressionAttributeValues: { ':minus': -1, ':zero': 0 },
                },
              });
            if (removedReference) {
              const deliveryKey = `delivery#${previous.notificationId}`;
              const delivery = await this.get<Delivery>(postId, deliveryKey);
              if (delivery?.status === 'PENDING')
                writes.push({
                  Update: {
                    TableName: this.table,
                    Key: { postId, key: deliveryKey },
                    UpdateExpression: 'REMOVE message.#data.commentId',
                    ConditionExpression: '#status = :pending',
                    ExpressionAttributeNames: {
                      '#data': 'data',
                      '#status': 'status',
                    },
                    ExpressionAttributeValues: { ':pending': 'PENDING' },
                  },
                });
            }
          }
          writes.push(this.put(postId, key, activity));
        }
      }
      writes.push({
        Put: {
          TableName: this.table,
          Item: { ...meta, postId, key: 'meta' },
          ConditionExpression: current
            ? 'revision = :revision'
            : 'attribute_not_exists(revision)',
          ...(current
            ? { ExpressionAttributeValues: { ':revision': current.revision } }
            : {}),
        },
      });
      writes.push({
        Put: {
          TableName: this.table,
          Item: { ...marker, postId, key: `event#${event.eventId}` },
          ConditionExpression: 'attribute_not_exists(#key)',
          ExpressionAttributeNames: { '#key': 'key' },
        },
      });
      try {
        // event marker, version, 묶음, 알림, 전송 작업을 하나의 영속 commit으로 반영한다.
        await this.client.send(
          new TransactWriteCommand({ TransactItems: writes }),
        );
        return recipient;
      } catch (error) {
        const candidate = error as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        };
        const conflict =
          candidate.name === 'TransactionConflictException' ||
          (candidate.name === 'TransactionCanceledException' &&
            candidate.CancellationReasons?.some((reason) =>
              ['ConditionalCheckFailed', 'TransactionConflict'].includes(
                reason.Code ?? '',
              ),
            ));
        if (!conflict || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
    throw new Error('Notification transaction retries exhausted');
  }

  async deliveries(postId?: string): Promise<Delivery[]> {
    const items: Delivery[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const input = {
        TableName: this.table,
        ConsistentRead: true,
        ExpressionAttributeNames: { '#key': 'key' },
        ExpressionAttributeValues: {
          ':prefix': 'delivery#',
          ...(postId ? { ':postId': postId } : {}),
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      };
      const result = postId
        ? await this.client.send(
            new QueryCommand({
              ...input,
              KeyConditionExpression:
                'postId = :postId AND begins_with(#key, :prefix)',
            }),
          )
        : await this.client.send(
            new ScanCommand({
              ...input,
              FilterExpression: 'begins_with(#key, :prefix)',
            }),
          );
      items.push(...((result.Items ?? []) as Delivery[]));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items.filter(
      (d) => d.status === 'PENDING' || d.status === 'SENDING',
    );
  }

  async acquire(
    delivery: Delivery,
    now = new Date(),
  ): Promise<Delivery | undefined> {
    const meta = await this.get<Meta>(delivery.postId, 'meta');
    const notificationId = delivery.message.data!.notificationId!;
    const result = await this.client.send(
      new GetCommand({
        TableName: this.notificationsTable,
        Key: { userId: delivery.message.userId, notificationId },
        ConsistentRead: true,
      }),
    );
    const notification = result.Item as Notification | undefined;
    const cancel =
      meta?.closed ||
      !notification ||
      notification.count <= 0 ||
      notification.expiresAt <= now.getTime() / 1000;
    try {
      const leaseId = randomUUID();
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { postId: delivery.postId, key: 'meta' },
                ConditionExpression: 'revision = :revision',
                ExpressionAttributeValues: { ':revision': meta?.revision ?? 0 },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { postId: delivery.postId, key: delivery.key },
                UpdateExpression:
                  'SET #status = :next, leaseId = :lease, leaseUntil = :until ADD attempts :one',
                ConditionExpression:
                  '(#status = :pending OR (#status = :sending AND leaseUntil <= :now)) AND (attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :now)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':pending': 'PENDING',
                  ':sending': 'SENDING',
                  ':next': cancel ? 'CANCELED' : 'SENDING',
                  ':lease': leaseId,
                  ':until': now.getTime() + 60_000,
                  ':now': now.getTime(),
                  ':one': 1,
                },
              },
            },
          ],
        }),
      );
      return cancel
        ? undefined
        : await this.get<Delivery>(delivery.postId, delivery.key);
    } catch (error) {
      if (
        [
          'ConditionalCheckFailedException',
          'TransactionCanceledException',
          'TransactionConflictException',
        ].includes((error as { name?: string }).name ?? '')
      )
        throw new BusyDeliveryError();
      throw error;
    }
  }

  async finish(
    delivery: Delivery,
    status: 'SENT' | 'FAILED' | 'PENDING' | 'CANCELED',
    retryTokens?: string[],
    now = new Date(),
  ): Promise<void> {
    const message = {
      ...delivery.message,
      ...(retryTokens ? { tokens: retryTokens } : {}),
    };
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { postId: delivery.postId, key: delivery.key },
        UpdateExpression:
          'SET #status = :status, message = :message, nextAttemptAt = :next REMOVE leaseId, leaseUntil',
        ConditionExpression: '#status = :sending AND leaseId = :lease',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':message': message,
          ':next':
            now.getTime() +
            Math.min(300_000, 1000 * 2 ** Math.min(delivery.attempts, 8)),
          ':sending': 'SENDING',
          ':lease': delivery.leaseId,
        },
      }),
    );
  }
}
