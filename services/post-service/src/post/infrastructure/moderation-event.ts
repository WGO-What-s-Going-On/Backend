import type { ModerationLifecycleEvent } from '../application/moderation.js';

export class InvalidModerationEvent extends Error {}
const states: Record<string, string> = {
  BOARD_STALE: 'STALE',
  BOARD_REACTIVATED: 'ACTIVE',
  BOARD_CLOSED: 'CLOSED',
};
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = (value: unknown, prefix: string) =>
  typeof value === 'string' && new RegExp(`^${prefix}_${uuid}$`).test(value);

export function parseModerationEvent(
  fields: Record<string, string>,
): ModerationLifecycleEvent | null {
  if (!Object.hasOwn(states, fields.eventType ?? '')) return null;
  try {
    if (!fields.data || Buffer.byteLength(fields.data) > 16384)
      throw new Error();
    const value = JSON.parse(fields.data);
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.producer !== 'moderation-service' ||
      value.eventType !== fields.eventType ||
      value.eventId !== fields.eventId ||
      !id(value.eventId, 'evt') ||
      !id(value.aggregateId, 'post') ||
      value.payload?.postId !== value.aggregateId ||
      value.payload?.state !== states[value.eventType] ||
      typeof value.correlationId !== 'string' ||
      !value.correlationId.trim() ||
      value.correlationId.length > 256 ||
      typeof value.occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(
        value.occurredAt,
      ) ||
      !Number.isFinite(Date.parse(value.occurredAt))
    )
      throw new Error();
    return {
      eventId: value.eventId,
      eventType: value.eventType,
      postId: value.aggregateId,
      occurredAt: new Date(value.occurredAt),
      correlationId: value.correlationId,
    };
  } catch {
    throw new InvalidModerationEvent('Invalid Moderation lifecycle v1 event');
  }
}
