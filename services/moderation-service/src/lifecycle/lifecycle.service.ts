import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  evaluateLifecycle,
  meaningfulActivity,
  type ReactionState,
  type LifecycleDecision,
  type LifecycleEvent,
  type LifecycleEventType,
  type LifecycleProjection,
} from './lifecycle.js';
import {
  LIFECYCLE_REPOSITORY,
  type LifecycleRepository,
} from './lifecycle.repository.js';

@Injectable()
export class LifecycleService {
  constructor(
    @Inject(LIFECYCLE_REPOSITORY)
    private readonly repository: LifecycleRepository,
  ) {}

  initialize(postId: string, occurredAt: string): Promise<boolean> {
    return this.repository.create({
      postId,
      state: 'ACTIVE',
      createdAt: occurredAt,
      lastMeaningfulActivityAt: occurredAt,
      staleAt: null,
      version: 0,
      reactionHistoryComplete: true,
    });
  }

  async recordReaction(
    postId: string,
    reaction: ReactionState,
    occurredAt: string,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    if (reaction.type === 'LIKE') return; // 과거 LIKE는 새 정책의 활동/종료 표로 환산하지 않는다.
    await this.change(postId, now, correlationId, (current) => {
      if (current.state === 'CLOSED') return { projection: current };
      const key = `${reaction.userId}:${reaction.type}`;
      if ((current.reactions?.[key]?.version ?? 0) >= reaction.version)
        return { projection: current };
      let next: LifecycleProjection = {
        ...current,
        reactions: { ...current.reactions, [key]: reaction },
        reactionHistorySince: current.reactionHistorySince ?? now.toISOString(),
        version: current.version + 1,
      };
      let decision: LifecycleDecision = { projection: next };
      if (reaction.active && reaction.type !== 'ENDED') {
        decision = meaningfulActivity(next, new Date(occurredAt));
        next = decision.projection;
      }
      // 의미 있는 새 활동은 이 처리에서 즉시 다시 STALE로 만들지 않는다.
      const evaluated =
        decision.eventType ||
        (next.state === 'ACTIVE' &&
          reaction.active &&
          reaction.type !== 'ENDED')
          ? decision
          : evaluateLifecycle(next, now);
      return {
        ...evaluated,
        projection: { ...evaluated.projection, version: current.version + 1 },
      };
    });
  }

  async canModerateComment(
    postId: string,
    commentId: string,
    version: number,
  ): Promise<boolean> {
    const current = await this.repository.find(postId);
    if (!current) throw new Error(`Lifecycle projection missing: ${postId}`);
    const comment = current.comments?.[commentId];
    return (
      !current.sourceState &&
      !(comment && (comment.deleted || comment.version >= version))
    );
  }

  async recordComment(
    postId: string,
    commentId: string,
    version: number,
    deleted: boolean,
    occurredAt: string,
    correlationId: string,
  ): Promise<void> {
    await this.change(
      postId,
      new Date(occurredAt),
      correlationId,
      (current) => {
        if (
          current.sourceState ||
          (current.state === 'CLOSED' && !deleted) ||
          (current.comments?.[commentId]?.version ?? 0) >= version
        )
          return { projection: current };
        const next = {
          ...current,
          comments: { ...current.comments, [commentId]: { version, deleted } },
          version: current.version + 1,
        };
        // API 요청 중 삭제가 커밋되었다면 이전 생성 버전은 위 CAS 재시도에서 무시된다.
        const decision = deleted
          ? { projection: next }
          : meaningfulActivity(next, new Date(occurredAt));
        return {
          ...decision,
          projection: { ...decision.projection, version: current.version + 1 },
        };
      },
    );
  }

  async terminate(
    postId: string,
    state: 'DELETED' | 'EXPIRED',
    postVersion: number,
    occurredAt: string,
    correlationId: string,
  ): Promise<void> {
    // 생성보다 종료가 먼저 도착해도 재생으로 부활하지 않도록 tombstone을 먼저 만든다.
    await this.repository.create({
      postId,
      state: 'CLOSED',
      sourceState: state,
      postVersion,
      createdAt: occurredAt,
      lastMeaningfulActivityAt: occurredAt,
      staleAt: null,
      version: 0,
    });
    await this.change(
      postId,
      new Date(occurredAt),
      correlationId,
      (current) => {
        if ((current.postVersion ?? 0) >= postVersion)
          return { projection: current };
        return {
          projection: {
            ...current,
            state: 'CLOSED',
            sourceState: state,
            postVersion,
            reactions: undefined,
            comments: undefined,
            endedSnapshot: undefined,
            endedAssessment: undefined,
            staleAt: null,
            staleReason: undefined,
            version: current.version + 1,
          },
        };
      },
    );
  }

  async recordActivity(
    postId: string,
    occurredAt: string,
    correlationId: string,
  ): Promise<void> {
    await this.change(
      postId,
      new Date(occurredAt),
      correlationId,
      meaningfulActivity,
    );
  }

  async evaluate(postId: string, now: Date): Promise<void> {
    await this.change(postId, now, `req_${randomUUID()}`, evaluateLifecycle);
  }

  list(): Promise<LifecycleProjection[]> {
    return this.repository.list();
  }

  private async change(
    postId: string,
    at: Date,
    correlationId: string,
    decide: (
      current: LifecycleProjection,
      at: Date,
    ) => { projection: LifecycleProjection; eventType?: LifecycleEventType },
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.repository.find(postId);
      if (!current) throw new Error(`Lifecycle projection missing: ${postId}`);
      const decision = decide(current, at);
      if (decision.projection === current) return;
      const event = decision.eventType
        ? lifecycleEvent(
            decision.eventType,
            decision.projection,
            at,
            correlationId,
          )
        : undefined;
      if (
        await this.repository.transition(
          current.version,
          decision.projection,
          event,
        )
      )
        return;
    }
    throw new Error(`Lifecycle transition conflict: ${postId}`);
  }
}

function lifecycleEvent(
  eventType: LifecycleEventType,
  projection: LifecycleProjection,
  occurredAt: Date,
  correlationId: string,
): LifecycleEvent {
  return {
    eventId: `evt_${randomUUID()}`,
    aggregateId: projection.postId,
    eventType,
    schemaVersion: 1,
    producer: 'moderation-service',
    correlationId,
    occurredAt: occurredAt.toISOString(),
    payload: { postId: projection.postId, state: projection.state },
  };
}
