import type { WebSocket } from 'ws';

export type JoinResult = 'joined' | 'already-joined' | 'room-limit-reached';

export class SubscriptionManager {
  readonly #roomsBySocket = new Map<WebSocket, Set<string>>();
  readonly #socketsByBoard = new Map<string, Set<WebSocket>>();

  constructor(readonly maxRoomsPerSocket: number) {}

  register(socket: WebSocket): void {
    if (!this.#roomsBySocket.has(socket)) this.#roomsBySocket.set(socket, new Set());
  }

  join(socket: WebSocket, boardId: string): JoinResult {
    const rooms = this.#roomsBySocket.get(socket);
    if (!rooms) throw new Error('Socket must be registered before joining a board');
    if (rooms.has(boardId)) return 'already-joined';
    if (rooms.size >= this.maxRoomsPerSocket) return 'room-limit-reached';

    rooms.add(boardId);
    const sockets = this.#socketsByBoard.get(boardId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.#socketsByBoard.set(boardId, sockets);
    return 'joined';
  }

  leave(socket: WebSocket, boardId: string): boolean {
    const rooms = this.#roomsBySocket.get(socket);
    if (!rooms?.delete(boardId)) return false;

    const sockets = this.#socketsByBoard.get(boardId);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.#socketsByBoard.delete(boardId);
    return true;
  }

  remove(socket: WebSocket): void {
    const rooms = this.#roomsBySocket.get(socket);
    if (!rooms) return;

    for (const boardId of rooms) {
      const sockets = this.#socketsByBoard.get(boardId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.#socketsByBoard.delete(boardId);
    }
    this.#roomsBySocket.delete(socket);
  }

  socketsForBoard(boardId: string): ReadonlySet<WebSocket> {
    return this.#socketsByBoard.get(boardId) ?? new Set();
  }

  roomsForSocket(socket: WebSocket): ReadonlySet<string> {
    return this.#roomsBySocket.get(socket) ?? new Set();
  }

  get socketCount(): number {
    return this.#roomsBySocket.size;
  }

  get boardCount(): number {
    return this.#socketsByBoard.size;
  }
}
