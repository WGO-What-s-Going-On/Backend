export const protocolVersion = 1 as const;

export interface ClientCommand {
  version: typeof protocolVersion;
  type: 'board.join' | 'board.leave' | 'post.get' | 'comment.list' | 'comment.create';
  requestId: string;
  payload: {
    boardId: string;
    content?: string;
    mutationId?: string;
    cursor?: string;
    limit?: number;
  };
}

export type ServerMessage =
  | {
      version: typeof protocolVersion;
      type: 'connection.ready';
      connectionId: string;
      userId: string;
      timestamp: string;
    }
  | {
      version: typeof protocolVersion;
      type: 'command.ack';
      requestId: string;
      timestamp: string;
    }
  | {
      version: typeof protocolVersion;
      type: 'command.error';
      requestId?: string;
      code: string;
      message: string;
      timestamp: string;
    }
  | { version: typeof protocolVersion; type: 'command.result'; requestId: string; result: unknown; timestamp: string }
  | { version: typeof protocolVersion; type: 'comment.created' | 'post.created' | 'post.reaction.created' | 'post.participant.joined'; eventId: string; postId: string; boardId: string; comment?: unknown };

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function parseClientCommand(raw: string): ClientCommand {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError('WS_INVALID_JSON', 'The message must be valid JSON.');
  }

  if (typeof value !== 'object' || value === null) {
    throw new ProtocolError('WS_INVALID_MESSAGE', 'The message must be an object.');
  }

  const message = value as Record<string, unknown>;
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;

  if (message.version !== protocolVersion) {
    throw new ProtocolError(
      'WS_UNSUPPORTED_VERSION',
      `Only protocol version ${protocolVersion} is supported.`,
      requestId,
    );
  }
  if (!['board.join', 'board.leave', 'post.get', 'comment.list', 'comment.create'].includes(String(message.type))) {
    throw new ProtocolError('WS_UNKNOWN_MESSAGE_TYPE', 'The message type is not supported.', requestId);
  }
  if (!requestId || requestId.length > 128) {
    throw new ProtocolError('WS_INVALID_REQUEST_ID', 'requestId is required.', requestId);
  }
  if (typeof message.payload !== 'object' || message.payload === null) {
    throw new ProtocolError('WS_INVALID_PAYLOAD', 'payload is required.', requestId);
  }

  const payload = message.payload as Record<string, unknown>;
  if (
    typeof payload.boardId !== 'string'
    || payload.boardId.length === 0
    || payload.boardId.length > 128
  ) {
    throw new ProtocolError('WS_INVALID_BOARD_ID', 'A valid boardId is required.', requestId);
  }

  if (message.type === 'comment.create' && (
    typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 2000
    || typeof payload.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.mutationId)
  )) throw new ProtocolError('WS_INVALID_PAYLOAD', 'Valid content and mutationId are required.', requestId);
  if (message.type === 'comment.list' && (
    (payload.cursor !== undefined && (typeof payload.cursor !== 'string' || payload.cursor.length > 1024))
    || (payload.limit !== undefined && (!Number.isInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 100))
  )) throw new ProtocolError('WS_INVALID_PAYLOAD', 'Invalid cursor or limit.', requestId);

  return {
    version: protocolVersion,
    type: message.type as ClientCommand['type'],
    requestId,
    payload: { boardId: payload.boardId, ...(message.type === 'comment.create' ? { content: payload.content as string, mutationId: payload.mutationId as string } : {}), ...(message.type === 'comment.list' && payload.cursor !== undefined ? { cursor: payload.cursor as string } : {}), ...(message.type === 'comment.list' && payload.limit !== undefined ? { limit: payload.limit as number } : {}) },
  };
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
