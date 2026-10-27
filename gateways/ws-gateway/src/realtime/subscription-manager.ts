import type { WebSocket } from 'ws';

export type JoinResult = 'joined' | 'already-joined' | 'room-limit-reached';

export class SubscriptionManager {
  readonly #roomsBySocket = new Map<WebSocket, Set<string>>();
  readonly #socketsByBoard = new Map<string, Set<WebSocket>>();

  readonly #pending = new Map<string, Set<{ valid: boolean }>>();

  constructor(readonly maxRoomsPerSocket: number) {}

  beginJoin(boardId: string): { valid: boolean } {
    const ticket = { valid: true };
    const pending = this.#pending.get(boardId) ?? new Set();
    pending.add(ticket);
    this.#pending.set(boardId, pending);
    return ticket;
  }

  endJoin(boardId: string, ticket: { valid: boolean }): void {
    const pending = this.#pending.get(boardId);
    pending?.delete(ticket);
    if (!pending?.size) this.#pending.delete(boardId);
  }

  closeBoard(boardId: string): void {
    for (const ticket of this.#pending.get(boardId) ?? []) ticket.valid = false;
    for (const socket of [...this.socketsForBoard(boardId)])
      this.leave(socket, boardId);
  }

  // Pub/Sub 단절 중 놓친 이벤트는 재생되지 않는다. 재연결 후 원본을 다시 읽도록 기존 구독을 폐기한다.
  reset(): WebSocket[] {
    for (const pending of this.#pending.values())
      for (const ticket of pending) ticket.valid = false;
    const sockets = [...this.#roomsBySocket.keys()];
    for (const socket of sockets) this.remove(socket);
    return sockets;
  }

  register(socket: WebSocket): void {
    if (!this.#roomsBySocket.has(socket))
      this.#roomsBySocket.set(socket, new Set());
  }

  canJoin(socket: WebSocket, boardId: string): boolean {
    const rooms = this.#roomsBySocket.get(socket);
    return (
      !!rooms && (rooms.has(boardId) || rooms.size < this.maxRoomsPerSocket)
    );
  }

  join(socket: WebSocket, boardId: string): JoinResult {
    const rooms = this.#roomsBySocket.get(socket);
    if (!rooms)
      throw new Error('Socket must be registered before joining a board');
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
