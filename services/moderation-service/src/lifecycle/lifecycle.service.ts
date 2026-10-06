import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  evaluateLifecycle,
  meaningfulActivity,
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
    });
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
