import { randomUUID } from 'node:crypto';
import type { EventType, OutboxEvent } from './ports.js';

export function event(aggregateId: string, eventType: EventType, payload: Record<string, unknown>, now: Date): OutboxEvent {
  return {
    eventId: `evt_${randomUUID()}`, aggregateId, eventType,
    schemaVersion: 1, producer: 'post-service',
    correlationId: `req_${randomUUID()}`, occurredAt: now, payload,
  };
}
