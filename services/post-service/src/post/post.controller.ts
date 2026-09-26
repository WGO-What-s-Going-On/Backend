import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, UseFilters } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiForbiddenResponse, ApiHeader, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiServiceUnavailableResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CreateComment, CreatePost, CreateReaction, JoinPost } from './application/commands.js';
import { ReadPosts } from './application/queries.js';
import { PostErrorFilter } from './presentation/post-error.filter.js';
import { commentInput, participantInput, postId, postInput, reactionInput, userId } from './presentation/post.input.js';
import { batchInput, commentCursor, commentLimit, internalAvailable } from './presentation/post-query.input.js';
import { internalServiceIdentity, serviceIdentity } from './presentation/service-auth.js';
import { BatchGetBody, BatchGetResponse, CommentPageResponse, CommentResponse, CreateCommentBody, CreatePostBody, CreateReactionBody, InternalCreateCommentBody, JoinPostBody, ParticipantResponse, PostMetaResponse, PostResponse, PostStatusResponse, ReactionResponse } from './presentation/post.openapi.js';

@Controller('api/v1/posts')
@ApiTags('Posts')
@ApiBadRequestResponse({ description: '입력값 또는 게시물 ID가 유효하지 않음' })
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
  @ApiOperation({ summary: '게시물 상세 조회', description: 'ACTIVE 게시물만 반환합니다.' })
  @ApiParam({ name: 'postId', example: 'post_123e4567-e89b-12d3-a456-426614174000' })
  @ApiOkResponse({ type: PostResponse })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  detail(@Param('postId') id: string) {
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  @ApiOperation({ summary: '댓글 목록 조회', description: 'ACTIVE 댓글을 최신순으로 반환합니다. 커서는 해당 게시물에만 사용할 수 있습니다.' })
  @ApiParam({ name: 'postId' })
  @ApiQuery({ name: 'cursor', required: false, description: '이전 응답의 nextCursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 30, schema: { minimum: 1, maximum: 100, default: 30 } })
  @ApiOkResponse({ type: CommentPageResponse })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  comments(@Param('postId') id: string, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    const validatedId = postId(id);
    return this.readPosts.comments(validatedId, commentCursor(cursor, validatedId), commentLimit(limit));
  }

  @Post()
  @ApiOperation({ summary: '게시물 작성', description: '로컬·테스트 전용 X-User-Id로 작성합니다. 운영에서는 인증 연동 전까지 503을 반환합니다.' })
  @ApiHeader({ name: 'X-User-Id', description: '양의 정수 사용자 ID (로컬·테스트 전용)', example: '123' })
  @ApiBody({ type: CreatePostBody })
  @ApiCreatedResponse({ type: PostResponse })
  @ApiForbiddenResponse({ description: '사용자 ID 헤더가 없거나 유효하지 않음' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  create(@Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createPost.execute(postInput(body), authorId);
  }

  @Post(':postId/comments')
  @ApiOperation({ summary: '댓글 작성', description: '게시물이 ACTIVE일 때 댓글·카운터·Outbox를 한 트랜잭션에 저장합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiHeader({ name: 'X-User-Id', description: '양의 정수 사용자 ID (로컬·테스트 전용)', example: '123' })
  @ApiBody({ type: CreateCommentBody })
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({ description: '사용자 ID가 유효하지 않거나 게시물이 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  comment(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createComment.execute(postId(id), commentInput(body), authorId);
  }

  @Post(':postId/reactions')
  @ApiOperation({ summary: 'LIKE 반응 작성', description: '같은 사용자의 반복 요청은 기존 반응을 반환합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiHeader({ name: 'X-User-Id', description: '양의 정수 사용자 ID (로컬·테스트 전용)', example: '123' })
  @ApiBody({ type: CreateReactionBody })
  @ApiCreatedResponse({ type: ReactionResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({ description: '사용자 ID가 유효하지 않거나 게시물이 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  reaction(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    reactionInput(body);
    return this.createReaction.execute(postId(id), actorId);
  }

  @Post(':postId/participants')
  @ApiOperation({ summary: '게시물 참여', description: '현재 위치 기반 허가는 로컬·테스트 대역입니다. 재참여를 지원합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiHeader({ name: 'X-User-Id', description: '양의 정수 사용자 ID (로컬·테스트 전용)', example: '123' })
  @ApiBody({ type: JoinPostBody, description: '빈 JSON 객체', examples: { empty: { value: {} } } })
  @ApiCreatedResponse({ type: ParticipantResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({ description: '사용자 ID가 유효하지 않거나 게시물이 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '운영 참여 허가 연동 전' })
  participant(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    participantInput(body);
    return this.joinPost.execute(postId(id), actorId);
  }
}

@Controller('internal/v1/posts')
@ApiTags('Internal Posts')
@ApiBadRequestResponse({ description: '입력값 또는 게시물 ID가 유효하지 않음' })
@UseFilters(PostErrorFilter)
export class InternalPostController {
  constructor(private readonly readPosts: ReadPosts, private readonly createComment: CreateComment) {}

  @Post('batch-get')
  @ApiOperation({ summary: '게시물 일괄 조회', description: '로컬·테스트 전용. 중복 ID를 제거하고 ACTIVE 게시물을 입력 순서대로 반환합니다.' })
  @ApiBody({ type: BatchGetBody })
  @ApiCreatedResponse({ type: BatchGetResponse })
  @ApiServiceUnavailableResponse({ description: '운영 환경에서는 비활성화됨' })
  batch(@Body() body: unknown) {
    internalAvailable();
    return this.readPosts.batch(batchInput(body));
  }

  @Get(':postId/meta')
  @ApiOperation({ summary: '게시물 메타 조회', description: '비활성 게시물도 실제 상태를 반환합니다. 운영에서는 서비스 JWT가 필요합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostMetaResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  meta(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    internalServiceIdentity(authorization);
    return this.readPosts.meta(postId(id));
  }

  @Get(':postId/status')
  @ApiOperation({ summary: '게시물 상태 조회', description: 'WS Gateway가 ACTIVE 여부를 확인할 때 사용합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostStatusResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  status(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    internalServiceIdentity(authorization);
    return this.readPosts.status(postId(id));
  }

  @Get(':postId')
  @ApiOperation({ summary: '내부 게시물 상세 조회', description: '서비스 JWT가 필요하며 ACTIVE 게시물만 반환합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  detail(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined) {
    serviceIdentity(authorization);
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  @ApiOperation({ summary: '내부 댓글 목록 조회', description: '서비스 JWT가 필요하며 HTTP 공개 조회와 같은 커서 형식입니다.' })
  @ApiParam({ name: 'postId' })
  @ApiQuery({ name: 'cursor', required: false, description: '이전 응답의 nextCursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 30, schema: { minimum: 1, maximum: 100, default: 30 } })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: CommentPageResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  comments(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    serviceIdentity(authorization);
    const validated = postId(id);
    return this.readPosts.comments(validated, commentCursor(cursor, validated), commentLimit(limit));
  }

  @Post(':postId/comments')
  @ApiOperation({ summary: '내부 댓글 작성', description: '서비스 JWT의 userId를 작성자로 사용합니다. 같은 사용자·게시물·mutationId 재요청은 기존 댓글을 반환합니다.' })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiBody({ type: InternalCreateCommentBody })
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({ description: '게시물이 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  comment(@Param('postId') id: string, @Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const authorId = serviceIdentity(authorization);
    if (authorId === null) throw new BadRequestException('userId required');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('JSON object required');
    const input = body as Record<string, unknown>;
    if (typeof input.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.mutationId)) throw new BadRequestException('Invalid mutationId');
    return this.createComment.execute(postId(id), commentInput({ content: input.content }), authorId, input.mutationId);
  }
}
