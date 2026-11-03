import {
  Body,
  Controller,
  Inject,
  Post,
  HttpCode,
  Req,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  POST_STATE_QUERIES,
  type PostStateQueries,
} from './application/ports.js';
import { verifiedModerationService } from './presentation/service-auth.js';
import { postId, commentId } from './presentation/post.input.js';

@ApiExcludeController()
@Controller('internal/v1/moderation')
export class ReportTargetController {
  constructor(
    @Inject(POST_STATE_QUERIES) private readonly queries: PostStateQueries,
  ) {}
  @Post('report-target')
  @HttpCode(200)
  async target(
    @Body() raw: unknown,
    @Req() request: { headers: Record<string, unknown>; rawHeaders: string[] },
  ) {
    if (
      request.rawHeaders.filter(
        (v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization',
      ).length !== 1
    )
      throw new UnauthorizedException('Service token required');
    verifiedModerationService(request.headers.authorization);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestException('Invalid report target');
    const b = raw as Record<string, unknown>;
    if (
      Object.keys(b).some(
        (k) => !['targetType', 'postId', 'commentId'].includes(k),
      ) ||
      !['POST', 'COMMENT'].includes(String(b.targetType)) ||
      typeof b.postId !== 'string' ||
      (b.targetType === 'COMMENT'
        ? typeof b.commentId !== 'string'
        : b.commentId !== undefined)
    )
      throw new BadRequestException('Invalid report target');
    const id = postId(b.postId),
      post = await this.queries.findPost(id);
    if (
      !post ||
      post.status !== 'ACTIVE' ||
      post.closedAt ||
      (post.expiresAt && post.expiresAt.getTime() <= Date.now())
    )
      throw new NotFoundException('Report target not found');
    if (b.targetType === 'COMMENT') {
      const comment = await this.queries.findComment(
        id,
        commentId(b.commentId as string),
      );
      if (!comment || comment.status !== 'ACTIVE')
        throw new NotFoundException('Report target not found');
    }
    // Only existence/state is disclosed to the authorized report intake service.
    return {
      verified: true,
      targetType: b.targetType,
      postId: id,
      ...(b.targetType === 'COMMENT' ? { commentId: b.commentId } : {}),
    };
  }
}
