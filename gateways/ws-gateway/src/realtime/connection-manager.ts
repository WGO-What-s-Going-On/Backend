import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

export interface ConnectionSession {
  connectionId: string;
  userId: string;
  connectedAt: Date;
}

interface ManagedSession extends ConnectionSession {
  heartbeatTimeout: NodeJS.Timeout | undefined;
}

export class ConnectionManager {
  readonly #sessions = new Map<WebSocket, ManagedSession>();
  readonly #socketsByUser = new Map<string, Set<WebSocket>>();
  #heartbeatInterval: NodeJS.Timeout | undefined;

  constructor(
    readonly heartbeatIntervalMs: number,
    readonly heartbeatTimeoutMs: number,
  ) {}

  register(socket: WebSocket, userId: string): ConnectionSession {
    const session: ManagedSession = {
      connectionId: randomUUID(),
      userId,
      connectedAt: new Date(),
      heartbeatTimeout: undefined,
    };
    this.#sessions.set(socket, session);

    const sockets = this.#socketsByUser.get(userId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.#socketsByUser.set(userId, sockets);

    socket.on('pong', () => this.#receivedPong(socket));
    return session;
  }

  remove(socket: WebSocket): ConnectionSession | undefined {
    const session = this.#sessions.get(socket);
    if (!session) return undefined;

    if (session.heartbeatTimeout) clearTimeout(session.heartbeatTimeout);
    this.#sessions.delete(socket);

    const sockets = this.#socketsByUser.get(session.userId);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.#socketsByUser.delete(session.userId);
    return session;
  }

  startHeartbeat(): void {
    if (this.#heartbeatInterval) return;

    this.#heartbeatInterval = setInterval(() => {
      for (const [socket, session] of this.#sessions) {
        if (socket.readyState !== WebSocket.OPEN || session.heartbeatTimeout) continue;

        socket.ping();
        session.heartbeatTimeout = setTimeout(() => {
          session.heartbeatTimeout = undefined;
          socket.terminate();
        }, this.heartbeatTimeoutMs);
      }
    }, this.heartbeatIntervalMs);
    this.#heartbeatInterval.unref();
  }

  stopHeartbeat(): void {
    if (this.#heartbeatInterval) clearInterval(this.#heartbeatInterval);
    this.#heartbeatInterval = undefined;

    for (const session of this.#sessions.values()) {
      if (session.heartbeatTimeout) clearTimeout(session.heartbeatTimeout);
      session.heartbeatTimeout = undefined;
    }
  }

  socketsForUser(userId: string): ReadonlySet<WebSocket> {
    return this.#socketsByUser.get(userId) ?? new Set();
  }

  get connectionCount(): number {
    return this.#sessions.size;
  }

  #receivedPong(socket: WebSocket): void {
    const session = this.#sessions.get(socket);
    if (!session?.heartbeatTimeout) return;
    clearTimeout(session.heartbeatTimeout);
    session.heartbeatTimeout = undefined;
  }
}
