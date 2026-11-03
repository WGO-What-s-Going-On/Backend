import { safeError, withLogContext } from './observability/logging.js';
import {
  loggingOptions,
  registerRequestLogging,
  requestFailure,
  gatewayContext,
} from './logging.js';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyBaseLogger,
} from 'fastify';
import { WebSocket, type RawData } from 'ws';

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
import {
  HttpPostClient,
  PostServiceError,
  type PostClient,
} from './realtime/post-client.js';
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

const socketLogs = new WeakMap<WebSocket, FastifyBaseLogger>();

function send(socket: WebSocket, message: ServerMessage): void {
  const log = socketLogs.get(socket);
  socket.send(serializeServerMessage(message), (error) => {
    if (error)
      log?.warn(
        {
          event: 'websocket.send.failed',
          domain: 'realtime',
          outcome: 'failure',
          error: safeError(error, 'WS_SEND_FAILED', 'WebSocket send failed.'),
        },
        'WebSocket send failed.',
      );
  });
  if (message.type === 'command.error')
    log?.warn(
      {
        event: 'websocket.command.completed',
        domain: 'realtime',
        outcome: 'failure',
        error: safeError(
          undefined,
          message.code,
          'WebSocket command rejected.',
        ),
      },
      'WebSocket command rejected.',
    );
  else if (message.type === 'command.ack' || message.type === 'command.result')
    log?.info(
      {
        event: 'websocket.command.completed',
        domain: 'realtime',
        outcome: 'success',
      },
      'WebSocket command completed.',
    );
}

function commandError(
  code: string,
  message: string,
  requestId?: string,
): ServerMessage {
  return requestId === undefined
    ? {
        version: protocolVersion,
        type: 'command.error',
        code,
        message,
        timestamp: new Date().toISOString(),
      }
    : {
        version: protocolVersion,
        type: 'command.error',
        requestId,
        code,
        message,
        timestamp: new Date().toISOString(),
      };
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger === false
      ? false
      : {
          ...loggingOptions('ws-gateway', config.logLevel),
          ...(config.logPretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { colorize: true, translateTime: 'SYS:standard' },
                },
              }
            : {}),
        };

  const app = Fastify({
    logger,
    trustProxy: false,
    disableRequestLogging: true,
  });
  registerRequestLogging(app);
  const authenticator =
    options.authenticator ?? new JwtAuthenticator(config.jwt);
  const postClient =
    options.postClient ?? new HttpPostClient(config.postService);
  const boardAccessAuthorizer =
    options.boardAccessAuthorizer ??
    (config.nodeEnv === 'test' && !options.postClient
      ? new UnavailableBoardAccessAuthorizer()
      : postClient);
  const connections = new ConnectionManager(
    config.websocket.heartbeatIntervalMs,
    config.websocket.heartbeatTimeoutMs,
    app.log,
  );
  const subscriptions = new SubscriptionManager(
    config.websocket.maxRoomsPerSocket,
  );
  const bus =
    options.realtimeBus ??
    (options.enableEvents ||
    (config.nodeEnv !== 'test' && !options.boardAccessAuthorizer)
      ? new PostEvents(config.redisUrl, subscriptions, app.log)
      : undefined);
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
    const boardAuthorization =
      boardAccessAuthorizer instanceof UnavailableBoardAccessAuthorizer
        ? 'unavailable'
        : 'configured';
    const events = bus
      ? bus.ready()
        ? 'ready'
        : 'unavailable'
      : 'unavailable';
    const metrics = events === 'ready' ? await bus?.metrics?.() : undefined;
    const body = {
      status:
        boardAuthorization === 'configured' &&
        (events === 'ready' || options.boardAccessAuthorizer)
          ? 'ready'
          : 'not-ready',
      dependencies: { boardAuthorization, events },
      connections: connections.connectionCount,
      ...(metrics
        ? {
            consumerPending: metrics.consumerPending,
            deliveryFailures: metrics.deliveryFailures,
          }
        : {}),
    };

    return body.status === 'ready' ? body : reply.code(503).send(body);
  });

  app.get(
    config.websocket.path,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && !config.websocket.allowedOrigins.includes(origin)) {
          requestFailure(
            request,
            'WS_ORIGIN_FORBIDDEN',
            'WebSocket origin is not allowed.',
          );
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
            requestFailure(
              request,
              error.code,
              'WebSocket authentication failed.',
              error,
            );
            return reply
              .code(401)
              .send({ code: 'WS_UNAUTHORIZED', message: error.message });
          }
          throw error;
        }
      },
    },
    (socket, request) => {
      const { userId } = (request as AuthenticatedRequest).authenticatedUser;
      const session = connections.register(socket, userId);
      subscriptions.register(socket);
      socketLogs.set(socket, request.log);
      request.log.info(
        {
          event: 'websocket.connected',
          domain: 'realtime',
          outcome: 'success',
          connectionId: session.connectionId,
        },
        'WebSocket connected.',
      );

      send(socket, {
        version: protocolVersion,
        type: 'connection.ready',
        connectionId: session.connectionId,
        userId,
        timestamp: new Date().toISOString(),
      });

      let messageQueue = Promise.resolve();
      // 같은 연결의 join → 조회/작성 순서가 네트워크 요청 중에도 뒤바뀌지 않게 한다.
      socket.on('message', (raw: RawData) => {
        messageQueue = messageQueue
          .then(() =>
            withLogContext(gatewayContext(request), async () => {
              const command = parseClientCommand(raw.toString());

              if (bus && !bus.ready()) {
                send(
                  socket,
                  commandError(
                    'WS_REALTIME_UNAVAILABLE',
                    'Reconnect and reload board state.',
                    command.requestId,
                  ),
                );
                return;
              }

              if (command.type === 'board.join') {
                // 인가 요청은 영속 참여를 기록하므로 Room 용량부터 확인한다.
                if (!subscriptions.canJoin(socket, command.payload.boardId)) {
                  send(
                    socket,
                    commandError(
                      'WS_ROOM_LIMIT_REACHED',
                      'The connection has reached its board subscription limit.',
                      command.requestId,
                    ),
                  );
                  return;
                }

                const ticket = subscriptions.beginJoin(command.payload.boardId);
                let allowed: boolean;
                try {
                  allowed = await boardAccessAuthorizer.canJoin({
                    userId,
                    boardId: command.payload.boardId,
                  });
                } catch (error) {
                  request.log.error(
                    {
                      event: 'websocket.authorization.failed',
                      domain: 'realtime',
                      outcome: 'failure',
                      connectionId: session.connectionId,
                      error: safeError(
                        error,
                        'WS_BOARD_AUTHORIZATION_UNAVAILABLE',
                        'Board authorization failed.',
                      ),
                    },
                    'Board authorization failed.',
                  );
                  send(
                    socket,
                    commandError(
                      'WS_BOARD_AUTHORIZATION_UNAVAILABLE',
                      'Board authorization is temporarily unavailable.',
                      command.requestId,
                    ),
                  );
                  return;
                } finally {
                  subscriptions.endJoin(command.payload.boardId, ticket);
                }

                if (!ticket.valid) {
                  send(
                    socket,
                    commandError(
                      'WS_BOARD_JOIN_FORBIDDEN',
                      'The board closed during authorization.',
                      command.requestId,
                    ),
                  );
                  return;
                }
                if (!allowed) {
                  send(
                    socket,
                    commandError(
                      'WS_BOARD_JOIN_FORBIDDEN',
                      'The user cannot join this board.',
                      command.requestId,
                    ),
                  );
                  return;
                }

                // 인가 중 연결이 끊겼다면 Room을 다시 만들지 않는다. 다른 연결의 영속 참여는 유지한다.
                if (socket.readyState !== WebSocket.OPEN) return;
                const result = subscriptions.join(
                  socket,
                  command.payload.boardId,
                );
                if (result === 'room-limit-reached') {
                  send(
                    socket,
                    commandError(
                      'WS_ROOM_LIMIT_REACHED',
                      'The connection has reached its board subscription limit.',
                      command.requestId,
                    ),
                  );
                  return;
                }
              } else if (command.type === 'board.leave') {
                subscriptions.leave(socket, command.payload.boardId);
              } else {
                // room 참여 전에 영속 데이터 조회나 작성을 수행하지 않는다.
                if (
                  !subscriptions
                    .roomsForSocket(socket)
                    .has(command.payload.boardId)
                ) {
                  send(
                    socket,
                    commandError(
                      'WS_BOARD_NOT_JOINED',
                      'Join the board first.',
                      command.requestId,
                    ),
                  );
                  return;
                }
                try {
                  const result =
                    command.type === 'post.get'
                      ? await postClient.detail(command.payload.boardId)
                      : command.type === 'comment.list'
                        ? await postClient.comments(
                            command.payload.boardId,
                            command.payload.cursor,
                            command.payload.limit,
                          )
                        : await postClient.createComment(
                            command.payload.boardId,
                            userId,
                            command.payload.content!,
                            command.payload.mutationId!,
                          );
                  if (
                    !subscriptions
                      .roomsForSocket(socket)
                      .has(command.payload.boardId)
                  ) {
                    send(
                      socket,
                      commandError(
                        'WS_BOARD_NOT_JOINED',
                        'The board subscription ended.',
                        command.requestId,
                      ),
                    );
                    return;
                  }
                  send(socket, {
                    version: protocolVersion,
                    type: 'command.result',
                    requestId: command.requestId,
                    result,
                    timestamp: new Date().toISOString(),
                  });
                } catch (error) {
                  request.log.warn(
                    {
                      event: 'websocket.command.failed',
                      domain: 'realtime',
                      outcome: 'failure',
                      connectionId: session.connectionId,
                      error: safeError(
                        error,
                        error instanceof PostServiceError && error.status < 500
                          ? 'WS_POST_REJECTED'
                          : 'WS_POST_UNAVAILABLE',
                        'Post operation failed.',
                      ),
                    },
                    'Post operation failed.',
                  );
                  const code =
                    error instanceof PostServiceError && error.status < 500
                      ? 'WS_POST_REJECTED'
                      : 'WS_POST_UNAVAILABLE';
                  send(
                    socket,
                    commandError(
                      code,
                      error instanceof PostServiceError && error.status < 500
                        ? error.message
                        : 'Post Service is temporarily unavailable.',
                      command.requestId,
                    ),
                  );
                }
                return;
              }

              send(socket, {
                version: protocolVersion,
                type: 'command.ack',
                requestId: command.requestId,
                timestamp: new Date().toISOString(),
              });
            }),
          )
          .catch((error: unknown) => {
            if (error instanceof ProtocolError) {
              request.log.warn(
                {
                  event: 'websocket.command.rejected',
                  domain: 'realtime',
                  outcome: 'failure',
                  error: safeError(
                    error,
                    error.code,
                    'Invalid WebSocket command.',
                  ),
                },
                'Invalid WebSocket command.',
              );
              send(
                socket,
                commandError(error.code, error.message, error.requestId),
              );
              return;
            }

            request.log.error(
              {
                event: 'websocket.command.failed',
                domain: 'realtime',
                outcome: 'failure',
                connectionId: session.connectionId,
                error: safeError(
                  error,
                  'WS_INTERNAL_ERROR',
                  'WebSocket command failed.',
                ),
              },
              'WebSocket command failed.',
            );
            send(
              socket,
              commandError(
                'WS_INTERNAL_ERROR',
                'The command could not be completed.',
              ),
            );
          });
      });

      socket.on('error', (error) => {
        request.log.warn(
          {
            event: 'websocket.connection.failed',
            domain: 'realtime',
            outcome: 'failure',
            connectionId: session.connectionId,
            error: safeError(
              error,
              'WS_CONNECTION_ERROR',
              'WebSocket transport failed.',
            ),
          },
          'WebSocket transport failed.',
        );
      });
      socket.once('close', (closeCode) => {
        request.log.info(
          {
            event: 'websocket.disconnected',
            domain: 'realtime',
            outcome: 'success',
            connectionId: session.connectionId,
            closeCode,
          },
          'WebSocket disconnected.',
        );
        subscriptions.remove(socket);
        connections.remove(socket);
      });
    },
  );

  connections.startHeartbeat();
  app.addHook('onClose', async () => {
    connections.stopHeartbeat();
    if (bus) await bus.close();
  });

  return app;
}
