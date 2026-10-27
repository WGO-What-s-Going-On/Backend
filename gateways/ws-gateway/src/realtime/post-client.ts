import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { AppConfig } from '../config.js';
import type { BoardAccessAuthorizer } from './board-access.js';

export class PostServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PostClient extends BoardAccessAuthorizer {
  detail(postId: string): Promise<unknown>;
  comments(postId: string, cursor?: string, limit?: number): Promise<unknown>;
  createComment(
    postId: string,
    userId: string,
    content: string,
    mutationId: string,
  ): Promise<unknown>;
}

export class HttpPostClient implements PostClient {
  private readonly signingKey?: KeyObject;
  private readonly kid?: string;

  constructor(private readonly config: AppConfig['postService']) {
    if (config.servicePrivateJwk) {
      try {
        const jwk = JSON.parse(config.servicePrivateJwk);
        if (
          jwk.alg !== 'ES256' ||
          jwk.kty !== 'EC' ||
          jwk.crv !== 'P-256' ||
          typeof jwk.kid !== 'string' ||
          !jwk.kid ||
          !jwk.d
        )
          throw new Error();
        this.signingKey = createPrivateKey({ key: jwk, format: 'jwk' });
        this.kid = jwk.kid;
      } catch {
        throw new Error('Invalid WS_SERVICE_PRIVATE_JWK');
      }
    }
  }

  private async token(userId?: string): Promise<string> {
    // 사용자 토큰을 전달하지 않고, 검증된 ID만 별도 단기 서비스 토큰에 담는다.
    const numericId = userId === undefined ? undefined : Number(userId);
    if (
      userId !== undefined &&
      (!Number.isSafeInteger(numericId) || numericId! <= 0)
    )
      throw new PostServiceError(400, 'Invalid user ID');
    if (this.signingKey && this.kid) {
      return new SignJWT({})
        .setProtectedHeader({
          alg: 'ES256',
          typ: 'wgo-service+jwt',
          kid: this.kid,
        })
        .setSubject('ws-gateway')
        .setIssuer('wgo-ws-gateway')
        .setAudience('wgo-post-service')
        .setIssuedAt()
        .setExpirationTime('30s')
        .sign(this.signingKey);
    }
    return new SignJWT(numericId === undefined ? {} : { userId: numericId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('ws-gateway')
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(new TextEncoder().encode(this.config.serviceSecret));
  }

  private async request(
    path: string,
    userId?: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${await this.token(userId)}`,
        ...(this.signingKey && userId !== undefined
          ? { 'X-User-Id': userId }
          : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok)
      throw new PostServiceError(
        response.status,
        `Post Service returned ${response.status}`,
      );
    return response.json();
  }

  async canJoin({
    boardId,
    userId,
  }: {
    boardId: string;
    userId: string;
  }): Promise<boolean> {
    try {
      // 새 참여 경로는 공유 secret으로 우회하지 않는다. Post가 위치와 영속 참여를 함께 처리한다.
      if (!this.signingKey)
        throw new PostServiceError(503, 'WS service signing key required');
      const participant = await this.request(
        `/internal/v1/posts/${encodeURIComponent(boardId)}/participants`,
        userId,
        {},
      );
      if (
        !participant ||
        typeof participant !== 'object' ||
        (participant as { postId?: unknown }).postId !== boardId ||
        String((participant as { userId?: unknown }).userId) !== userId ||
        (participant as { leftAt?: unknown }).leftAt !== null
      )
        throw new PostServiceError(502, 'Invalid participation response');
      return true;
    } catch (error) {
      if (
        error instanceof PostServiceError &&
        [403, 404].includes(error.status)
      )
        return false;
      throw error;
    }
  }

  detail(postId: string): Promise<unknown> {
    return this.request(`/internal/v1/posts/${encodeURIComponent(postId)}`);
  }

  comments(postId: string, cursor?: string, limit?: number): Promise<unknown> {
    const query = new URLSearchParams();
    if (cursor) query.set('cursor', cursor);
    if (limit) query.set('limit', String(limit));
    return this.request(
      `/internal/v1/posts/${encodeURIComponent(postId)}/comments?${query}`,
    );
  }

  createComment(
    postId: string,
    userId: string,
    content: string,
    mutationId: string,
  ): Promise<unknown> {
    return this.request(
      `/internal/v1/posts/${encodeURIComponent(postId)}/comments`,
      userId,
      { content, mutationId },
    );
  }
}
