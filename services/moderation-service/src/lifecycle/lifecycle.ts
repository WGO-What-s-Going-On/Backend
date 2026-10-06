export type LifecycleState = 'ACTIVE' | 'STALE' | 'CLOSED';
export type LifecycleEventType =
  | 'BOARD_STALE'
  | 'BOARD_REACTIVATED'
  | 'BOARD_CLOSED';

export interface LifecycleProjection {
  postId: string;
  state: LifecycleState;
  createdAt: string;
  lastMeaningfulActivityAt: string;
  staleAt: string | null;
  version: number;
}

export interface LifecycleEvent {
  eventId: string;
  aggregateId: string;
  eventType: LifecycleEventType;
  schemaVersion: 1;
  producer: 'moderation-service';
  correlationId: string;
  occurredAt: string;
  payload: { postId: string; state: LifecycleState };
}

export interface LifecycleDecision {
  projection: LifecycleProjection;
  eventType?: LifecycleEventType;
}

const HOUR = 60 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

export function meaningfulActivity(
  current: LifecycleProjection,
  at: Date,
): LifecycleDecision {
  if (current.state === 'CLOSED') return { projection: current };
  if (at.getTime() <= Date.parse(current.lastMeaningfulActivityAt))
    return { projection: current };
  const projection = {
    ...current,
    state: 'ACTIVE' as const,
    lastMeaningfulActivityAt: at.toISOString(),
    staleAt: null,
    version: current.version + 1,
  };
  return current.state === 'STALE'
    ? { projection, eventType: 'BOARD_REACTIVATED' }
    : { projection };
}

export function evaluateLifecycle(
  current: LifecycleProjection,
  now: Date,
): LifecycleDecision {
  const timestamp = now.getTime();
  if (
    current.state === 'ACTIVE' &&
    timestamp - Date.parse(current.createdAt) >= HOUR &&
    timestamp - Date.parse(current.lastMeaningfulActivityAt) >= THIRTY_MINUTES
  ) {
    return {
      projection: {
        ...current,
        state: 'STALE',
        staleAt: now.toISOString(),
        version: current.version + 1,
      },
      eventType: 'BOARD_STALE',
    };
  }
  if (
    current.state === 'STALE' &&
    current.staleAt !== null &&
    timestamp - Date.parse(current.staleAt) >= TEN_MINUTES
  ) {
    return {
      projection: { ...current, state: 'CLOSED', version: current.version + 1 },
      eventType: 'BOARD_CLOSED',
    };
  }
  return { projection: current };
}
