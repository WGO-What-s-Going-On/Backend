export const protocolVersion = 1 as const;

export interface ClientCommand {
  version: typeof protocolVersion;
  type: 'board.join' | 'board.leave';
  requestId: string;
  payload: {
    boardId: string;
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
    };

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
  if (message.type !== 'board.join' && message.type !== 'board.leave') {
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

  return {
    version: protocolVersion,
    type: message.type,
    requestId,
    payload: { boardId: payload.boardId },
  };
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
