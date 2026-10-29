import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CreateReportRequest } from './report.dto.js';

@Injectable()
export class ReportTarget {
  private readonly origin: string | undefined;
  constructor(config: ConfigService) {
    const url = config.get<string>('reports.postUrl');
    if (url) {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/'
      )
        throw new Error('REPORTS_POST_SERVICE_URL must be a service origin');
      this.origin = parsed.origin;
    }
  }
  async verify(input: CreateReportRequest): Promise<void> {
    if (!this.origin)
      throw new ServiceUnavailableException(
        'Report target verification is not configured',
      );
    // Use existing public, active-only Post read contracts. No cross-service DB
    // access and no assumption that the local Lifecycle projection is complete.
    const signal = AbortSignal.timeout(3000);
    const read = async (path: string): Promise<Record<string, unknown>> => {
      try {
        const result = await fetch(`${this.origin}${path}`, {
          signal,
          redirect: 'error',
        });
        if (result.status === 404)
          throw new NotFoundException('Report target not found');
        if (!result.ok) throw new Error();
        return (await result.json()) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof NotFoundException) throw error;
        throw new ServiceUnavailableException(
          'Report target verification unavailable',
        );
      }
    };
    const path = `/api/v1/posts/${input.postId}`;
    const post = await read(path);
    if (
      post.postId !== input.postId ||
      post.status !== 'ACTIVE' ||
      (post.expiresAt !== null &&
        (typeof post.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(post.expiresAt))))
    )
      throw new ServiceUnavailableException(
        'Invalid Post verification response',
      );
    if (
      typeof post.expiresAt === 'string' &&
      Date.parse(post.expiresAt) <= Date.now()
    )
      throw new NotFoundException('Report target expired');
    if (input.targetType === 'POST') return;
    let cursor: string | null = null;
    // Bound work on busy posts. Exhausting the budget means unknown, never 404
    // or an unverified successful report. A dedicated target RPC is a follow-up.
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const data = await read(
        `${path}/comments?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (
        !Array.isArray(data.comments) ||
        !(data.nextCursor === null || typeof data.nextCursor === 'string')
      )
        throw new ServiceUnavailableException('Invalid Post comment response');
      if (
        data.comments.some(
          (comment) =>
            comment &&
            comment.commentId === input.commentId &&
            comment.postId === input.postId &&
            comment.status === 'ACTIVE',
        )
      )
        return;
      cursor = data.nextCursor as string | null;
      if (cursor === null)
        throw new NotFoundException('Report comment not found');
      if (cursor.length > 2000 || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new ServiceUnavailableException(
      'Report target verification budget exceeded',
    );
  }
}
