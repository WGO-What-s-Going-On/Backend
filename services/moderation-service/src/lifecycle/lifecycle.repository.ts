import type { LifecycleEvent, LifecycleProjection } from './lifecycle.js';

export const LIFECYCLE_REPOSITORY = Symbol('LIFECYCLE_REPOSITORY');

export interface LifecycleRepository {
  create(projection: LifecycleProjection): Promise<boolean>;
  find(postId: string): Promise<LifecycleProjection | null>;
  list(): Promise<LifecycleProjection[]>;
  transition(
    expectedVersion: number,
    next: LifecycleProjection,
    event?: LifecycleEvent,
  ): Promise<boolean>;
}
