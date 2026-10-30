import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
export interface RewardEventContext {
  eventId: string;
  correlationId: string;
}
export async function emitRewardEvent(
  m: EntityManager,
  userId: string,
  context: RewardEventContext,
  type: string,
  payload: Record<string, unknown>,
) {
  const eventId = randomUUID(),
    now = new Date();
  await m.getRepository(OutboxEventEntity).insert({
    eventId,
    aggregateId: userId,
    eventType: type,
    payload: {
      eventId,
      type,
      target: { type: 'USER', id: userId },
      occurredAt: now.toISOString(),
      version: 1,
      producer: 'user-service',
      correlationId: context.correlationId,
      payload: { userId, sourceEventId: context.eventId, ...payload },
    },
    status: 'PENDING',
    publishAttempts: 0,
    createdAt: now,
    publishedAt: null,
  });
}
