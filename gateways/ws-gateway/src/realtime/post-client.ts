import { SignJWT } from 'jose';
import type { AppConfig } from '../config.js';
import type { BoardAccessAuthorizer } from './board-access.js';

export class PostServiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface PostClient extends BoardAccessAuthorizer {
  detail(postId: string): Promise<unknown>;
  comments(postId: string, cursor?: string, limit?: number): Promise<unknown>;
  createComment(postId: string, userId: string, content: string, mutationId: string): Promise<unknown>;
}

export class HttpPostClient implements PostClient {
  constructor(private readonly config: AppConfig['postService']) {}

  private async token(userId?: string): Promise<string> {
    const numericId = userId === undefined ? undefined : Number(userId);
    if (userId !== undefined && (!Number.isSafeInteger(numericId) || numericId! <= 0)) throw new PostServiceError(400, 'Invalid user ID');
    return new SignJWT(numericId === undefined ? {} : { userId: numericId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject('ws-gateway')
      .setIssuer(this.config.issuer).setAudience(this.config.audience)
      .setIssuedAt().setExpirationTime('30s')
      .sign(new TextEncoder().encode(this.config.serviceSecret));
  }

  private async request(path: string, userId?: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await this.token(userId)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new PostServiceError(response.status, `Post Service returned ${response.status}`);
    return response.json();
  }

  async canJoin({ boardId }: { boardId: string; userId: string }): Promise<boolean> {
    try {
      const status = await this.request(`/internal/v1/posts/${encodeURIComponent(boardId)}/status`) as { status: string };
      return status.status === 'ACTIVE';
    } catch (error) {
      if (error instanceof PostServiceError && error.status === 404) return false;
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
    return this.request(`/internal/v1/posts/${encodeURIComponent(postId)}/comments?${query}`);
  }

  createComment(postId: string, userId: string, content: string, mutationId: string): Promise<unknown> {
    return this.request(`/internal/v1/posts/${encodeURIComponent(postId)}/comments`, userId, { content, mutationId });
  }
}
