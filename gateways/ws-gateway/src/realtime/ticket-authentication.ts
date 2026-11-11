import { jwtVerify } from 'jose';
import { createClient } from 'redis';
import {
  AuthenticationError,
  type AuthenticatedUser,
} from './authentication.js';

export interface TicketUses {
  consume(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export class TicketStoreUnavailableError extends Error {}

export class RedisTicketUses implements TicketUses {
  private readonly client;
  private connecting: Promise<unknown> | undefined;

  constructor(url: string) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        socketTimeout: 2000,
        reconnectStrategy: false,
      },
    });
    // 요청 경계에서 일반화한 503과 로그를 남기며 Redis 주소·자격 증명은 노출하지 않는다.
    this.client.on('error', () => {});
  }

  async consume(id: string): Promise<boolean> {
    try {
      if (!this.client.isReady) {
        this.connecting ??= this.client.connect().finally(() => {
          this.connecting = undefined;
        });
        await this.connecting;
      }
      // 모든 WS Pod가 같은 Redis를 사용한다. NX 성공자만 입장하며 티켓 전체는 저장하지 않는다.
      return (
        (await this.client.set(`ws:ticket:used:${id}`, '1', {
          NX: true,
          EX: 60,
        })) === 'OK'
      );
    } catch {
      throw new TicketStoreUnavailableError('Ticket verification unavailable.');
    }
  }

  async close(): Promise<void> {
    if (this.connecting) await this.connecting.catch(() => {});
    if (this.client.isOpen) this.client.destroy();
  }
}

export async function authenticateTicket(
  ticket: string,
  secret: string,
  uses: TicketUses,
): Promise<AuthenticatedUser> {
  let userId: string;
  let id: string;
  try {
    if (!ticket || ticket.length > 2048) throw new Error();
    const { payload } = await jwtVerify(
      ticket,
      new TextEncoder().encode(secret),
      {
        algorithms: ['HS256'],
        typ: 'wgo-ws-ticket+jwt',
        issuer: 'wgo-http-gateway',
        audience: 'wgo-ws-gateway',
        requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
      },
    );
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      typeof payload.sub !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(payload.sub) ||
      BigInt(payload.sub) > 9007199254740991n ||
      typeof payload.jti !== 'string' ||
      !uuid.test(payload.jti) ||
      typeof payload.sid !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.sid,
      ) ||
      typeof payload.iat !== 'number' ||
      !Number.isInteger(payload.iat) ||
      payload.iat < 0 ||
      payload.iat > Math.floor(Date.now() / 1000) + 5 ||
      typeof payload.exp !== 'number' ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 45
    )
      throw new Error();
    userId = payload.sub;
    id = payload.jti;
  } catch {
    throw new AuthenticationError(
      'The WebSocket ticket is invalid or expired.',
    );
  }
  if (!(await uses.consume(id)))
    throw new AuthenticationError('The WebSocket ticket was already used.');
  return { userId };
}
