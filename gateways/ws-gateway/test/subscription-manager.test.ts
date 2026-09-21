import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { SubscriptionManager } from '../src/realtime/subscription-manager.js';

function socket(): WebSocket {
  return {} as WebSocket;
}

describe('SubscriptionManager', () => {
  it('keeps both directions consistent and makes join idempotent', () => {
    const manager = new SubscriptionManager(2);
    const first = socket();
    const second = socket();
    manager.register(first);
    manager.register(second);

    expect(manager.join(first, 'board-1')).toBe('joined');
    expect(manager.join(first, 'board-1')).toBe('already-joined');
    expect(manager.join(second, 'board-1')).toBe('joined');
    expect(manager.socketsForBoard('board-1').size).toBe(2);
    expect(manager.roomsForSocket(first)).toEqual(new Set(['board-1']));
  });

  it('removes every board index when a socket disconnects', () => {
    const manager = new SubscriptionManager(2);
    const client = socket();
    manager.register(client);
    manager.join(client, 'board-1');
    manager.join(client, 'board-2');

    manager.remove(client);

    expect(manager.socketCount).toBe(0);
    expect(manager.boardCount).toBe(0);
  });

  it('enforces the per-socket room limit', () => {
    const manager = new SubscriptionManager(1);
    const client = socket();
    manager.register(client);

    expect(manager.join(client, 'board-1')).toBe('joined');
    expect(manager.join(client, 'board-2')).toBe('room-limit-reached');
  });
});
