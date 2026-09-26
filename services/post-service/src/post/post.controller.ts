import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, UseFilters } from '@nestjs/common';
import { CreateComment, CreatePost, CreateReaction, JoinPost } from './application/commands.js';
import { ReadPosts } from './application/queries.js';
import { PostErrorFilter } from './presentation/post-error.filter.js';
import { commentInput, participantInput, postId, postInput, reactionInput, userId } from './presentation/post.input.js';
import { batchInput, commentCursor, commentLimit, internalAvailable } from './presentation/post-query.input.js';
import { internalServiceIdentity, serviceIdentity } from './presentation/service-auth.js';

@Controller('api/v1/posts')
@UseFilters(PostErrorFilter)
export class PostController {
  constructor(
    private readonly createPost: CreatePost,
    private readonly createComment: CreateComment,
    private readonly createReaction: CreateReaction,
    private readonly joinPost: JoinPost,
    private readonly readPosts: ReadPosts,
  ) {}

  @Get(':postId')
  detail(@Param('postId') id: string) {
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  comments(@Param('postId') id: string, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    const validatedId = postId(id);
    return this.readPosts.comments(validatedId, commentCursor(cursor, validatedId), commentLimit(limit));
  }

  @Post()
  create(@Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createPost.execute(postInput(body), authorId);
  }

  @Post(':postId/comments')
  comment(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createComment.execute(postId(id), commentInput(body), authorId);
  }

  @Post(':postId/reactions')
  reaction(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    reactionInput(body);
    return this.createReaction.execute(postId(id), actorId);
  }

  @Post(':postId/participants')
  participant(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    participantInput(body);
    return this.joinPost.execute(postId(id), actorId);
  }
}

@Controller('internal/v1/posts')
@UseFilters(PostErrorFilter)
export class InternalPostController {
  constructor(private readonly readPosts: ReadPosts, private readonly createComment: CreateComment) {}

  @Post('batch-get')
  batch(@Body() body: unknown) {
    internalAvailable();
    return this.readPosts.batch(batchInput(body));
  }

  @Get(':postId/meta')
  meta(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    internalServiceIdentity(authorization);
    return this.readPosts.meta(postId(id));
  }

  @Get(':postId/status')
  status(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    internalServiceIdentity(authorization);
    return this.readPosts.status(postId(id));
  }

  @Get(':postId')
  detail(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    serviceIdentity(authorization);
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  comments(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    serviceIdentity(authorization);
    const validated = postId(id);
    return this.readPosts.comments(validated, commentCursor(cursor, validated), commentLimit(limit));
  }

  @Post(':postId/comments')
  comment(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const authorId = serviceIdentity(authorization);
    if (authorId === null) throw new BadRequestException('userId required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('JSON object required');
    const input = body as Record<string, unknown>;
    if (typeof input.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.mutationId)) throw new BadRequestException('Invalid mutationId');
    return this.createComment.execute(postId(id), commentInput({ content: input.content }), authorId, input.mutationId);
  }
}
