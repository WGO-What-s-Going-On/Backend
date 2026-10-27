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
  staleReason?: 'INACTIVITY' | 'ENDED' | undefined;
  endedSnapshot?: EndedAssessment | undefined;
  endedAssessment?: EndedAssessment | undefined;
  reactions?: Record<string, ReactionState> | undefined;
  reactionHistoryComplete?: boolean;
  reactionHistorySince?: string;
  comments?: Record<string, { version: number; deleted: boolean }> | undefined;
  sourceState?: 'DELETED' | 'EXPIRED';
  postVersion?: number;
  pendingPublication?: LifecycleEvent;
}

export type ReactionType =
  | 'CURIOUS'
  | 'STILL_HAPPENING'
  | 'HELPFUL'
  | 'ENDED'
  | 'LIKE';
export interface ReactionState {
  userId: number;
  type: ReactionType;
  version: number;
  active: boolean;
  createdAt: string;
}
export interface EndedAssessment {
  capturedAt: string;
  windowStart: string;
  endedCount: number;
  recentReactionUserCount: number;
  ratio: number;
  minimumEnded: 5;
  minimumRatio: 0.7;
  certain: boolean;
  voters: ReactionState[];
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
export const TEN_MINUTES = 10 * 60 * 1000;

export function reactivate(current: LifecycleProjection): LifecycleDecision {
  return {
    projection: {
      ...current,
      state: 'ACTIVE',
      staleAt: null,
      staleReason: undefined,
      endedSnapshot: undefined,
      endedAssessment: undefined,
      version: current.version + 1,
    },
    eventType: 'BOARD_REACTIVATED',
  };
}

export function assessEnded(
  current: LifecycleProjection,
  now: Date,
): EndedAssessment {
  // 유예 중에는 진입 시 하한을 고정해 기존 공감이 시간 경과만으로 빠지지 않게 한다.
  const windowStart =
    current.staleReason === 'ENDED' && current.endedSnapshot
      ? current.endedSnapshot.windowStart
      : new Date(now.getTime() - TEN_MINUTES).toISOString();
  const active = Object.values(current.reactions ?? {}).filter((r) => r.active);
  const users = new Map<number, ReactionState[]>();
  for (const reaction of active)
    users.set(reaction.userId, [
      ...(users.get(reaction.userId) ?? []),
      reaction,
    ]);
  // 종류별 버전은 서로 비교할 수 없다. 취소가 아직 도착하지 않은 다중 활성 상태는 종료 근거로 쓰지 않는다.
  const certain =
    [...users.values()].every((rs) => rs.length === 1) &&
    (current.reactionHistoryComplete === true ||
      (current.reactionHistorySince !== undefined &&
        now.getTime() - Date.parse(current.reactionHistorySince) >=
          TEN_MINUTES));
  const voters = [...users.values()]
    .filter((rs) => rs.length === 1)
    .map((rs) => rs[0]!)
    .filter(
      (r) =>
        r.type !== 'LIKE' &&
        Date.parse(r.createdAt) > Date.parse(windowStart) &&
        Date.parse(r.createdAt) <= now.getTime(),
    );
  const endedCount = voters.filter((r) => r.type === 'ENDED').length;
  return {
    capturedAt: now.toISOString(),
    windowStart,
    endedCount,
    recentReactionUserCount: voters.length,
    ratio: voters.length ? endedCount / voters.length : 0,
    minimumEnded: 5,
    minimumRatio: 0.7,
    certain,
    voters,
  };
}

export function endedCondition(a: EndedAssessment): boolean {
  return (
    a.certain &&
    a.endedCount >= a.minimumEnded &&
    a.recentReactionUserCount > 0 &&
    a.endedCount * 10 >= a.recentReactionUserCount * 7
  );
}

export function meaningfulActivity(
  current: LifecycleProjection,
  at: Date,
): LifecycleDecision {
  if (current.state === 'CLOSED') return { projection: current };
  const reopens =
    current.state === 'STALE' &&
    current.staleAt !== null &&
    at.getTime() >= Date.parse(current.staleAt);
  if (
    at.getTime() < Date.parse(current.lastMeaningfulActivityAt) ||
    (at.getTime() === Date.parse(current.lastMeaningfulActivityAt) && !reopens)
  )
    return { projection: current };
  const base = reopens ? reactivate(current).projection : current;
  const projection = {
    ...base,
    lastMeaningfulActivityAt: at.toISOString(),
    version: current.version + 1,
  };
  return reopens
    ? { projection, eventType: 'BOARD_REACTIVATED' }
    : { projection };
}

export function evaluateLifecycle(
  current: LifecycleProjection,
  now: Date,
): LifecycleDecision {
  const timestamp = now.getTime();
  if (current.state === 'CLOSED') return { projection: current };
  const assessment = assessEnded(current, now);
  if (
    current.state === 'STALE' &&
    current.staleReason === 'ENDED' &&
    !endedCondition(assessment)
  ) {
    return reactivate(current);
  }
  if (current.state === 'ACTIVE' && endedCondition(assessment)) {
    return {
      projection: {
        ...current,
        state: 'STALE',
        staleAt: now.toISOString(),
        staleReason: 'ENDED',
        endedSnapshot: assessment,
        endedAssessment: assessment,
        version: current.version + 1,
      },
      eventType: 'BOARD_STALE',
    };
  }
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
        staleReason: 'INACTIVITY',
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
      projection: {
        ...current,
        state: 'CLOSED',
        // Terminal state replaces relation tombstones; retain decision evidence separately.
        reactions: undefined,
        comments: undefined,
        ...(current.staleReason === 'ENDED'
          ? { endedAssessment: assessment }
          : {}),
        version: current.version + 1,
      },
      eventType: 'BOARD_CLOSED',
    };
  }
  return { projection: current };
}
