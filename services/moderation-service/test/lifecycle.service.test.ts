import { describe, expect, it } from 'vitest';

import type {
  LifecycleEvent,
  LifecycleProjection,
} from '../src/lifecycle/lifecycle.js';
import type { LifecycleRepository } from '../src/lifecycle/lifecycle.repository.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';

class MemoryLifecycle implements LifecycleRepository {
  values = new Map<string, LifecycleProjection>();
  events: LifecycleEvent[] = [];
  async create(value: LifecycleProjection) {
    if (this.values.has(value.postId)) return false;
    this.values.set(value.postId, value);
    return true;
  }
  async find(postId: string) {
    return this.values.get(postId) ?? null;
  }
  async list() {
    return [...this.values.values()];
  }
  async transition(
    version: number,
    next: LifecycleProjection,
    event?: LifecycleEvent,
  ) {
    if (this.values.get(next.postId)?.version !== version) return false;
    this.values.set(next.postId, next);
    if (event) this.events.push(event);
    return true;
  }
}

describe('LifecycleService', () => {
  it('initializes PostCreated once without resetting timestamps', async () => {
    const repository = new MemoryLifecycle();
    const service = new LifecycleService(repository);
    await service.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await service.initialize('post_1', '2026-01-02T00:00:00.000Z');
    expect(await repository.find('post_1')).toMatchObject({
      state: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastMeaningfulActivityAt: '2026-01-01T00:00:00.000Z',
      staleAt: null,
    });
  });

  it('keeps posts ACTIVE during the first hour and transitions once after inactivity', async () => {
    const repository = new MemoryLifecycle();
    const service = new LifecycleService(repository);
    await service.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await service.evaluate('post_1', new Date('2026-01-01T00:59:59.000Z'));
    expect((await repository.find('post_1'))?.state).toBe('ACTIVE');
    await service.evaluate('post_1', new Date('2026-01-01T01:00:00.000Z'));
    await service.evaluate('post_1', new Date('2026-01-01T01:01:00.000Z'));
    expect(await repository.find('post_1')).toMatchObject({
      state: 'STALE',
      staleAt: '2026-01-01T01:00:00.000Z',
    });
    expect(repository.events.map((event) => event.eventType)).toEqual([
      'BOARD_STALE',
    ]);
  });

  it('closes STALE after ten minutes and never reopens CLOSED', async () => {
    const repository = new MemoryLifecycle();
    const service = new LifecycleService(repository);
    await service.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await service.evaluate('post_1', new Date('2026-01-01T01:00:00.000Z'));
    await service.evaluate('post_1', new Date('2026-01-01T01:10:00.000Z'));
    await service.recordActivity(
      'post_1',
      '2026-01-01T01:11:00.000Z',
      'req_comment',
    );
    expect((await repository.find('post_1'))?.state).toBe('CLOSED');
    expect(repository.events.map((event) => event.eventType)).toEqual([
      'BOARD_STALE',
      'BOARD_CLOSED',
    ]);
  });

  it('reactivates STALE on a comment and emits BOARD_REACTIVATED once', async () => {
    const repository = new MemoryLifecycle();
    const service = new LifecycleService(repository);
    await service.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await service.evaluate('post_1', new Date('2026-01-01T01:00:00.000Z'));
    await service.recordActivity(
      'post_1',
      '2026-01-01T01:05:00.000Z',
      'req_comment',
    );
    expect(await repository.find('post_1')).toMatchObject({
      state: 'ACTIVE',
      staleAt: null,
      lastMeaningfulActivityAt: '2026-01-01T01:05:00.000Z',
    });
    expect(repository.events.at(-1)).toMatchObject({
      eventType: 'BOARD_REACTIVATED',
      correlationId: 'req_comment',
    });
  });

  it('updates ACTIVE activity without emitting an event and ignores older activity', async () => {
    const repository = new MemoryLifecycle();
    const service = new LifecycleService(repository);
    await service.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await service.recordActivity(
      'post_1',
      '2026-01-01T00:10:00.000Z',
      'req_new',
    );
    await service.recordActivity(
      'post_1',
      '2026-01-01T00:05:00.000Z',
      'req_old',
    );
    expect(await repository.find('post_1')).toMatchObject({
      state: 'ACTIVE',
      lastMeaningfulActivityAt: '2026-01-01T00:10:00.000Z',
    });
    expect(repository.events).toHaveLength(0);
  });
});
