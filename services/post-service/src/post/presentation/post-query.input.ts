import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { CommentCursor } from '../application/ports.js';
import { postId } from './post.input.js';

export function internalAvailable(): void {
  if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Internal service authentication unavailable');
}

export function batchInput(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('JSON object required');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'postIds') || !Array.isArray(body.postIds) || body.postIds.length > 100) {
    throw new BadRequestException('postIds must be an array of at most 100 IDs');
  }
  return body.postIds.map((id: unknown) => {
    if (typeof id !== 'string') throw new BadRequestException('Invalid postId');
    return postId(id);
  });
}

export function commentLimit(raw: unknown): number {
  if (raw === undefined) return 30;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) throw new BadRequestException('Invalid limit');
  const limit = Number(raw);
  if (limit > 100) throw new BadRequestException('Invalid limit');
  return limit;
}

export function commentCursor(raw: unknown, requestedPostId: string): CommentCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw) || raw.length > 1024) throw new BadRequestException('Invalid cursor');
  try {
    // 커서를 다른 게시물에 재사용하지 못하게 postId까지 검증한다.
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('cursor');
    const value = decoded as Record<string, unknown>;
    if (value.postId !== requestedPostId || typeof value.createdAt !== 'string' || typeof value.id !== 'string' || !/^[0-9a-f]{24}$/.test(value.id)) throw new Error('cursor');
    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) throw new Error('cursor');
    return { createdAt, id: value.id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
