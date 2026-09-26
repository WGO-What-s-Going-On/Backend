import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import { loadConfig, type AppConfig } from './config.js';
import {
  AuthenticationError,
  JwtAuthenticator,
  type AuthenticatedUser,
  type Authenticator,
} from './realtime/authentication.js';
import {
  type BoardAccessAuthorizer,
  UnavailableBoardAccessAuthorizer,
} from './realtime/board-access.js';
import { ConnectionManager } from './realtime/connection-manager.js';
import {
  parseClientCommand,
  protocolVersion,
  ProtocolError,
  serializeServerMessage,
  type ServerMessage,
} from './realtime/protocol.js';
import { SubscriptionManager } from './realtime/subscription-manager.js';
import { HttpPostClient, PostServiceError, type PostClient } from './realtime/post-client.js';
import { PostEvents, type RealtimeBus } from './realtime/post-events.js';

interface AuthenticatedRequest extends FastifyRequest {
  authenticatedUser: AuthenticatedUser;
}

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  authenticator?: Authenticator;
  boardAccessAuthorizer?: BoardAccessAuthorizer;
  postClient?: PostClient;
  realtimeBus?: RealtimeBus;
  enableEvents?: boolean;
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(serializeServerMessage(message));
}

function commandError(
  code: string,
  message: string,
  requestId?: string,
): ServerMessage {
  return requestId === undefined
    ? { version: protocolVersion, type: 'command.error', code, message, timestamp: new Date().toISOString() }
    : {
        version: protocolVersion,
        type: 'command.error',
        requestId,
        code,
        message,
        timestamp: new Date().toISOString(),
      };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const logger = options.logger === false
    ? false
    : config.logPretty
      ? {
          level: config.logLevel,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : { level: config.logLevel };

  const app = Fastify({ logger, trustProxy: false });
  const authenticator = options.authenticator ?? new JwtAuthenticator(config.jwt);
  const postClient = options.postClient ?? new HttpPostClient(config.postService);
  const boardAccessAuthorizer = options.boardAccessAuthorizer ?? (config.nodeEnv === 'test' && !options.postClient ? new UnavailableBoardAccessAuthorizer() : postClient);
  const connections = new ConnectionManager(
    config.websocket.heartbeatIntervalMs,
    config.websocket.heartbeatTimeoutMs,
  );
  const subscriptions = new SubscriptionManager(config.websocket.maxRoomsPerSocket);
  const bus = options.realtimeBus ?? (options.enableEvents || (config.nodeEnv !== 'test' && !options.boardAccessAuthorizer) ? new PostEvents(config.redisUrl, subscriptions, app.log) : undefined);
  if (bus) await bus.start();

  await app.register(cookie);
  await app.register(websocket, {
    options: {
      maxPayload: config.websocket.maxPayloadBytes,
      perMessageDeflate: false,
    },
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const boardAuthorization = boardAccessAuthorizer instanceof UnavailableBoardAccessAuthorizer ? 'unavailable' : 'configured';
    const events = bus ? (bus.ready() ? 'ready' : 'unavailable') : 'unavailable';
    const metrics = events === 'ready' ? await bus?.metrics?.() : undefined;
    const body = {
      status: boardAuthorization === 'configured' && (events === 'ready' || options.boardAccessAuthorizer) ? 'ready' : 'not-ready',
      dependencies: { boardAuthorization, events },
      connections: connections.connectionCount,
      ...(metrics ? { consumerPending: metrics.consumerPending, deliveryFailures: metrics.deliveryFailures } : {}),
    };

    return body.status === 'ready' ? body : reply.code(503).send(body);
  });

  app.get(config.websocket.path, {
    websocket: true,
    preValidation: async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && !config.websocket.allowedOrigins.includes(origin)) {
        return reply.code(403).send({
          code: 'WS_ORIGIN_FORBIDDEN',
          message: 'The WebSocket origin is not allowed.',
        });
      }

      try {
        const user = await authenticator.authenticate(request);
        (request as AuthenticatedRequest).authenticatedUser = user;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply.code(401).send({ code: 'WS_UNAUTHORIZED', message: error.message });
        }
        throw error;
      }
    },
  }, (socket, request) => {
    const { userId } = (request as AuthenticatedRequest).authenticatedUser;
    const session = connections.register(socket, userId);
    subscriptions.register(socket);

    send(socket, {
      version: protocolVersion,
      type: 'connection.ready',
      connectionId: session.connectionId,
      userId,
      timestamp: new Date().toISOString(),
    });

    let messageQueue = Promise.resolve();
    socket.on('message', (raw: RawData) => {
      messageQueue = messageQueue
        .then(async () => {
          const command = parseClientCommand(raw.toString());

          if (command.type === 'board.join') {
            let allowed: boolean;
            try {
              allowed = await boardAccessAuthorizer.canJoin({
                userId,
                boardId: command.payload.boardId,
              });
            } catch (error) {
              request.log.error({ err: error }, 'board authorization failed');
              send(socket, commandError(
                'WS_BOARD_AUTHORIZATION_UNAVAILABLE',
                'Board authorization is temporarily unavailable.',
                command.requestId,
              ));
              return;
            }

            if (!allowed) {
              send(socket, commandError(
                'WS_BOARD_JOIN_FORBIDDEN',
                'The user cannot join this board.',
                command.requestId,
              ));
              return;
            }

            const result = subscriptions.join(socket, command.payload.boardId);
            if (result === 'room-limit-reached') {
              send(socket, commandError(
                'WS_ROOM_LIMIT_REACHED',
                'The connection has reached its board subscription limit.',
                command.requestId,
              ));
              return;
            }
          } else if (command.type === 'board.leave') {
            subscriptions.leave(socket, command.payload.boardId);
          } else {
            if (!subscriptions.roomsForSocket(socket).has(command.payload.boardId)) {
              send(socket, commandError('WS_BOARD_NOT_JOINED', 'Join the board first.', command.requestId));
              return;
            }
            try {
              const result = command.type === 'post.get'
                ? await postClient.detail(command.payload.boardId)
                : command.type === 'comment.list'
                  ? await postClient.comments(command.payload.boardId, command.payload.cursor, command.payload.limit)
                  : await postClient.createComment(command.payload.boardId, userId, command.payload.content!, command.payload.mutationId!);
              send(socket, { version: protocolVersion, type: 'command.result', requestId: command.requestId, result, timestamp: new Date().toISOString() });
            } catch (error) {
              const code = error instanceof PostServiceError && error.status < 500 ? 'WS_POST_REJECTED' : 'WS_POST_UNAVAILABLE';
              send(socket, commandError(code, error instanceof PostServiceError && error.status < 500 ? error.message : 'Post Service is temporarily unavailable.', command.requestId));
            }
            return;
          }

          send(socket, {
            version: protocolVersion,
            type: 'command.ack',
            requestId: command.requestId,
            timestamp: new Date().toISOString(),
          });
        })
        .catch((error: unknown) => {
          if (error instanceof ProtocolError) {
            send(socket, commandError(error.code, error.message, error.requestId));
            return;
          }

          request.log.error({ err: error }, 'websocket command failed');
          send(socket, commandError('WS_INTERNAL_ERROR', 'The command could not be completed.'));
        });
    });

    socket.once('close', () => {
      subscriptions.remove(socket);
      connections.remove(socket);
    });
  });

  connections.startHeartbeat();
  app.addHook('onClose', async () => {
    connections.stopHeartbeat();
    if (bus) await bus.close();
  });

  return app;
}
