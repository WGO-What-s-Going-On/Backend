import { PostLifecycle } from './application/lifecycle.js';
import { MongooseVote } from './infrastructure/mongoose-vote.js';
import { VoteBody, VoteResponse } from './presentation/vote.openapi.js';
import { CommentReactionType, PostReactionType } from './domain/post.js';
import { FindSimilarPosts } from './semantic/search.js';
import {
  SimilarPostsBody,
  SimilarPostsResponse,
} from './presentation/similar.openapi.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CreateComment,
  CreateCommentReaction,
  CreatePost,
  CreateReaction,
  JoinPost,
} from './application/commands.js';
import { ReadPosts } from './application/queries.js';
import { PostErrorFilter } from './presentation/post-error.filter.js';
import {
  commentInput,
  commentReactionInput,
  commentReactionType,
  commentId,
  participantInput,
  postId,
  postInput,
  similarInput,
  reactionInput,
  reactionType,
  userId,
} from './presentation/post.input.js';
import {
  batchInput,
  commentCursor,
  commentLimit,
  internalAvailable,
} from './presentation/post-query.input.js';
import {
  internalServiceIdentity,
  verifiedWsUser,
  serviceIdentity,
} from './presentation/service-auth.js';
import {
  BatchGetBody,
  BatchGetResponse,
  CommentPageResponse,
  CommentResponse,
  CommentReactionResponse,
  CreateCommentReactionBody,
  CreateCommentBody,
  CreatePostBody,
  CreateReactionBody,
  InternalCreateCommentBody,
  JoinPostBody,
  ParticipantResponse,
  PostMetaResponse,
  PostResponse,
  PostStatusResponse,
  ReactionResponse,
} from './presentation/post.openapi.js';

@Controller('api/v1/posts')
@ApiTags('Posts')
@ApiBadRequestResponse({ description: '입력값 또는 게시물 ID가 유효하지 않음' })
@UseFilters(PostErrorFilter)
export class PostController {
  constructor(
    private readonly createPost: CreatePost,
    private readonly createComment: CreateComment,
    private readonly createCommentReaction: CreateCommentReaction,
    private readonly createReaction: CreateReaction,
    private readonly joinPost: JoinPost,
    private readonly readPosts: ReadPosts,
    private readonly findSimilar: FindSimilarPosts,
    private readonly lifecycle: PostLifecycle,
    private readonly votes: MongooseVote,
  ) {}

  @Get(':postId/vote')
  @ApiOperation({
    summary: '투표 및 합의 결과 조회',
    description:
      '종료·삭제 후에도 후보와 확정 결과를 반환합니다. 기존 게시물과 후보 부족은 NONE입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    required: false,
    description: '로컬·테스트에서만 본인 선택 조회',
  })
  @ApiOkResponse({ type: VoteResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  vote(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
  ) {
    return this.votes.read(
      postId(id),
      header && process.env.NODE_ENV !== 'production'
        ? userId(header)
        : undefined,
    );
  }

  @Put(':postId/vote')
  @ApiOperation({
    summary: '후보 선택 또는 표 이동',
    description:
      'Map Service 위치 검증 후 사용자당 한 표를 기록합니다. 같은 선택은 멱등 처리합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({ name: 'X-User-Id', description: '로컬·테스트 전용 사용자 ID' })
  @ApiBody({ type: VoteBody })
  @ApiOkResponse({ type: VoteResponse })
  @ApiForbiddenResponse({ description: '투표 종료 또는 위치 거부' })
  @ApiServiceUnavailableResponse({
    description: '운영 인증 미연결 또는 Map Service 장애',
  })
  chooseVote(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('commentId' in body)
    )
      throw new BadRequestException('commentId required');
    return this.votes.choose(
      postId(id),
      userId(header),
      commentId((body as VoteBody).commentId),
    );
  }

  @Delete(':postId/vote')
  @ApiOperation({
    summary: '본인 표 취소',
    description: '새 위치 확인 없이 본인 표를 취소합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({ name: 'X-User-Id', description: '로컬·테스트 전용 사용자 ID' })
  @ApiOkResponse({ type: VoteResponse })
  cancelVote(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
  ) {
    return this.votes.cancel(postId(id), userId(header));
  }

  @Delete(':postId')
  @HttpCode(204)
  @ApiOperation({
    summary: '작성자 본인의 게시물 삭제',
    description:
      '반복 요청은 추가 이벤트 없이 204. 삭제·만료된 게시물의 본인 활동 정리도 허용합니다. 운영 인증 연동 전에는 503입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물 또는 대상 댓글이 없음' })
  @ApiForbiddenResponse({ description: '잘못된 사용자 ID 또는 작성자 불일치' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async deletePost(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.deletePost(postId(id), userId(header));
  }

  @Delete(':postId/comments/:commentId')
  @HttpCode(204)
  @ApiOperation({
    summary: '작성자 본인의 댓글 삭제',
    description:
      '반복 요청은 추가 이벤트 없이 204. 삭제·만료된 게시물의 본인 활동 정리도 허용합니다. 운영 인증 연동 전에는 503입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiParam({ name: 'commentId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물 또는 대상 댓글이 없음' })
  @ApiForbiddenResponse({ description: '잘못된 사용자 ID 또는 작성자 불일치' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async deleteComment(
    @Param('postId') id: string,
    @Param('commentId') cid: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.deleteComment(
      postId(id),
      commentId(cid),
      userId(header),
    );
  }

  @Delete(':postId/comments/:commentId/reactions/:type')
  @HttpCode(204)
  @ApiOperation({
    summary: '본인의 댓글 공감 취소',
    description:
      '같은 취소 요청은 추가 변경 없이 204를 반환합니다. 댓글 또는 게시물 비활성화 후에도 취소할 수 있습니다. 이벤트는 발행하지 않습니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiParam({ name: 'commentId' })
  @ApiParam({ name: 'type', enum: CommentReactionType })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물 또는 댓글이 없음' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async removeCommentReaction(
    @Param('postId') id: string,
    @Param('commentId') cid: string,
    @Param('type') type: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.removeCommentReaction(
      postId(id),
      commentId(cid),
      userId(header),
      commentReactionType(type),
    );
  }

  @Delete(':postId/reactions')
  @HttpCode(204)
  @ApiOperation({
    summary: '기존 LIKE 공감 취소',
    description:
      '반복 요청은 추가 이벤트 없이 204. 삭제·만료된 게시물의 본인 활동 정리도 허용합니다. 운영 인증 연동 전에는 503입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물 또는 대상 댓글이 없음' })
  @ApiForbiddenResponse({ description: '잘못된 사용자 ID 또는 작성자 불일치' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async removeReaction(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.removeReaction(postId(id), userId(header), 'LIKE');
  }

  @Delete(':postId/reactions/:type')
  @HttpCode(204)
  @ApiOperation({
    summary: '본인의 지정한 종류 공감 취소',
    description:
      '반복 요청은 추가 이벤트 없이 204. 기존 LIKE 취소는 이전 경로도 지원합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiParam({ name: 'type', enum: PostReactionType })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async removeReactionByType(
    @Param('postId') id: string,
    @Param('type') type: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.removeReaction(
      postId(id),
      userId(header),
      reactionType(type),
    );
  }

  @Delete(':postId/participants')
  @HttpCode(204)
  @ApiOperation({
    summary: '본인의 게시물 참여 종료',
    description:
      '반복 요청은 추가 이벤트 없이 204. 삭제·만료된 게시물의 본인 활동 정리도 허용합니다. 운영 인증 연동 전에는 503입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiNoContentResponse({ description: '처리 완료 또는 이미 처리됨' })
  @ApiNotFoundResponse({ description: '게시물 또는 대상 댓글이 없음' })
  @ApiForbiddenResponse({ description: '잘못된 사용자 ID 또는 작성자 불일치' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  async leave(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
  ): Promise<void> {
    await this.lifecycle.leave(postId(id), userId(header));
  }

  @Post('similar')
  @HttpCode(200)
  @ApiOperation({
    summary: '작성 초안의 유사 게시물 조회',
    description:
      '150m·최근 24시간, 후보 최대 200개. 초안을 저장하지 않습니다. 로컬 E5 모델 로딩·워밍업 또는 평가된 임계값이 준비되지 않으면 SIMILARITY_CHECK_UNAVAILABLE(503). 로컬·테스트 인증 정책은 작성 API와 같습니다.',
  })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiBody({ type: SimilarPostsBody })
  @ApiOkResponse({ type: SimilarPostsResponse })
  @ApiForbiddenResponse({ description: '사용자 또는 위치 인가 거부' })
  @ApiServiceUnavailableResponse({
    description:
      'SIMILARITY_CHECK_UNAVAILABLE: 모델·임계값 미준비, 의존성 오류 또는 timeout. 운영 사용자 인증 미연결도 503.',
  })
  similar(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const actorId = userId(header);
    return this.findSimilar.execute(similarInput(body), actorId);
  }

  @Get(':postId')
  @ApiOperation({
    summary: '게시물 상세 조회',
    description: 'ACTIVE 게시물만 반환합니다.',
  })
  @ApiParam({
    name: 'postId',
    example: 'post_123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({ type: PostResponse })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  detail(@Param('postId') id: string) {
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  @ApiOperation({
    summary: '댓글 목록 조회',
    description:
      'ACTIVE 댓글을 최신순으로 반환합니다. 커서는 해당 게시물에만 사용할 수 있습니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '이전 응답의 nextCursor',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 30,
    schema: { minimum: 1, maximum: 100, default: 30 },
  })
  @ApiOkResponse({ type: CommentPageResponse })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  comments(
    @Param('postId') id: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const validatedId = postId(id);
    return this.readPosts.comments(
      validatedId,
      commentCursor(cursor, validatedId),
      commentLimit(limit),
    );
  }

  @Post()
  @ApiOperation({
    summary: '게시물 작성',
    description:
      '로컬·테스트 전용 X-User-Id로 작성합니다. Map Service가 최근 위치를 확인합니다. 운영에서는 인증 연동 전까지 503을 반환합니다.',
  })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
    example: '123',
  })
  @ApiBody({ type: CreatePostBody })
  @ApiCreatedResponse({ type: PostResponse })
  @ApiForbiddenResponse({
    description: '사용자 ID가 유효하지 않거나 최근 위치가 없거나 반경 밖임',
  })
  @ApiServiceUnavailableResponse({
    description: '운영 인증 연동 전 또는 Map Service 장애',
  })
  create(
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const authorId = userId(header);
    return this.createPost.execute(postInput(body), authorId);
  }

  @Post(':postId/comments')
  @ApiOperation({
    summary: '댓글 작성',
    description:
      '게시물이 ACTIVE일 때 댓글·카운터·Outbox를 한 트랜잭션에 저장합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
    example: '123',
  })
  @ApiBody({ type: CreateCommentBody })
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({
    description: '사용자 ID가 유효하지 않거나 게시물이 비활성 상태',
  })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  comment(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const authorId = userId(header);
    return this.createComment.execute(postId(id), commentInput(body), authorId);
  }

  @Post(':postId/comments/:commentId/reactions')
  @ApiOperation({
    summary: '댓글 공감 작성',
    description:
      '한 사용자가 댓글에 종류별로 하나씩 누를 수 있습니다. 같은 종류의 반복 요청은 기존 공감을 반환하며 이벤트는 발행하지 않습니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiParam({ name: 'commentId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
  })
  @ApiBody({ type: CreateCommentReactionBody })
  @ApiCreatedResponse({ type: CommentReactionResponse })
  @ApiConflictResponse({
    description:
      'REACTION_ALREADY_EXISTS: 다른 종류의 공감을 취소한 뒤 다시 선택해야 함',
  })
  @ApiNotFoundResponse({ description: '게시물 또는 댓글이 없음' })
  @ApiForbiddenResponse({ description: '게시물 또는 댓글이 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  commentReaction(
    @Param('postId') id: string,
    @Param('commentId') cid: string,
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    return this.createCommentReaction.execute(
      postId(id),
      commentId(cid),
      userId(header),
      commentReactionInput(body),
    );
  }

  @Post(':postId/reactions')
  @ApiOperation({
    summary: '게시물 공감 작성',
    description:
      '한 사용자가 종류별로 하나씩 누를 수 있으며, 같은 종류의 반복 요청은 기존 반응을 반환합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
    example: '123',
  })
  @ApiBody({ type: CreateReactionBody })
  @ApiCreatedResponse({ type: ReactionResponse })
  @ApiConflictResponse({
    description:
      'REACTION_ALREADY_EXISTS: 다른 종류의 공감을 취소한 뒤 다시 선택해야 함',
  })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({
    description: '사용자 ID가 유효하지 않거나 게시물이 비활성 상태',
  })
  @ApiServiceUnavailableResponse({ description: '운영 인증 연동 전' })
  reaction(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const actorId = userId(header);
    return this.createReaction.execute(
      postId(id),
      actorId,
      reactionInput(body),
    );
  }

  @Post(':postId/participants')
  @ApiOperation({
    summary: '게시물 참여',
    description:
      'Map Service가 최근 위치와 게시물 반경을 확인합니다. 재참여를 지원합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiHeader({
    name: 'X-User-Id',
    description: '양의 정수 사용자 ID (로컬·테스트 전용)',
    example: '123',
  })
  @ApiBody({
    type: JoinPostBody,
    description: '빈 JSON 객체',
    examples: { empty: { value: {} } },
  })
  @ApiCreatedResponse({ type: ParticipantResponse })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({
    description:
      '사용자 ID가 유효하지 않거나 게시물이 비활성 상태이거나 위치 허가 거부',
  })
  @ApiServiceUnavailableResponse({
    description: '운영 인증 연동 전 또는 Map Service 장애',
  })
  participant(
    @Param('postId') id: string,
    @Headers('x-user-id') header: string | undefined,
    @Body() body: unknown,
  ) {
    const actorId = userId(header);
    participantInput(body);
    return this.joinPost.execute(postId(id), actorId);
  }
}

@Controller('internal/v1/posts')
// 서비스 간 호출 경로다. 메타·상태 조회의 로컬 호환 동작과 인증 정책은 각 메서드에서 결정한다.
@ApiTags('Internal Posts')
@ApiBadRequestResponse({ description: '입력값 또는 게시물 ID가 유효하지 않음' })
@UseFilters(PostErrorFilter)
export class InternalPostController {
  constructor(
    private readonly readPosts: ReadPosts,
    private readonly createComment: CreateComment,
    private readonly joinPost: JoinPost,
  ) {}

  @Post('batch-get')
  @ApiOperation({
    summary: '게시물 일괄 조회',
    description:
      '로컬·테스트 전용. 중복 ID를 제거하고 ACTIVE 게시물을 입력 순서대로 반환합니다.',
  })
  @ApiBody({ type: BatchGetBody })
  @ApiCreatedResponse({ type: BatchGetResponse })
  @ApiServiceUnavailableResponse({ description: '운영 환경에서는 비활성화됨' })
  batch(@Body() body: unknown) {
    internalAvailable();
    return this.readPosts.batch(batchInput(body));
  }

  @Get(':postId/meta')
  @ApiOperation({
    summary: '게시물 메타 조회',
    description:
      '비활성 게시물도 실제 상태를 반환합니다. 운영에서는 서비스 JWT가 필요합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostMetaResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  meta(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    internalServiceIdentity(authorization);
    return this.readPosts.meta(postId(id));
  }

  @Get(':postId/status')
  @ApiOperation({
    summary: '게시물 상태 조회',
    description: '게시물 상태 정보입니다. 참여 허가를 의미하지 않습니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostStatusResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  status(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    internalServiceIdentity(authorization);
    return this.readPosts.status(postId(id));
  }

  @Get(':postId')
  @ApiOperation({
    summary: '내부 게시물 상세 조회',
    description: '서비스 JWT가 필요하며 ACTIVE 게시물만 반환합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: PostResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  detail(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    serviceIdentity(authorization);
    return this.readPosts.detail(postId(id));
  }

  @Get(':postId/comments')
  @ApiOperation({
    summary: '내부 댓글 목록 조회',
    description: '서비스 JWT가 필요하며 HTTP 공개 조회와 같은 커서 형식입니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '이전 응답의 nextCursor',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 30,
    schema: { minimum: 1, maximum: 100, default: 30 },
  })
  @ApiBearerAuth('service-jwt')
  @ApiOkResponse({ type: CommentPageResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없거나 비활성 상태' })
  @ApiServiceUnavailableResponse({ description: '서비스 JWT 설정이 없음' })
  comments(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    serviceIdentity(authorization);
    const validated = postId(id);
    return this.readPosts.comments(
      validated,
      commentCursor(cursor, validated),
      commentLimit(limit),
    );
  }

  @Post(':postId/participants')
  @ApiOperation({
    summary: 'WS 게시물 참여',
    description:
      'WS Gateway ES256 서비스 인증과 검증된 사용자 문맥이 필요합니다. HTTP 참여와 같은 위치·게시물 검증을 수행합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiHeader({
    name: 'X-User-Id',
    required: true,
    description:
      'ES256 인증된 WS Gateway가 검증한 사용자 ID. 외부 클라이언트 입력이 아님.',
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiCreatedResponse({
    description: '참여 정보. 중복 참여는 카운터와 이벤트를 추가하지 않음.',
  })
  @ApiUnauthorizedResponse({
    description: '서비스 인증 또는 사용자 문맥이 유효하지 않음',
  })
  @ApiForbiddenResponse({
    description: '위치 없음·만료·반경 밖 또는 비활성 게시물',
  })
  @ApiServiceUnavailableResponse({
    description: '위치 인가 또는 인증 설정 불가',
  })
  participate(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Req() request: { rawHeaders: string[] },
  ) {
    requireSingleAuthorization(request.rawHeaders);
    return this.joinPost.execute(
      postId(id),
      verifiedWsUser(authorization, userId),
    );
  }

  @Post(':postId/comments')
  @ApiOperation({
    summary: '내부 댓글 작성',
    description:
      '검증된 WS 사용자 문맥을 작성자로 사용하며 참여·최신 위치를 확인합니다. 같은 사용자·게시물·mutationId 재요청은 기존 댓글을 반환합니다.',
  })
  @ApiParam({ name: 'postId' })
  @ApiBearerAuth('service-jwt')
  @ApiHeader({
    name: 'X-User-Id',
    required: false,
    description:
      'ES256 서비스 JWT에는 필수인 검증된 사용자 문맥. 기존 HS256 호출은 토큰 userId 사용.',
    schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
  })
  @ApiBody({ type: InternalCreateCommentBody })
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiUnauthorizedResponse({ description: '서비스 JWT가 없거나 유효하지 않음' })
  @ApiNotFoundResponse({ description: '게시물이 없음' })
  @ApiForbiddenResponse({
    description: '게시물 비활성·미참여 또는 최신 위치 조건 미충족',
  })
  @ApiServiceUnavailableResponse({
    description: '서비스 인증 설정 또는 위치 인가 불가',
  })
  comment(
    @Param('postId') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Body() body: unknown,
    @Req() request: { rawHeaders: string[] },
  ) {
    requireSingleAuthorization(request.rawHeaders);
    const authorId = serviceIdentity(authorization, userId);
    if (authorId === null) throw new BadRequestException('userId required');
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('JSON object required');
    const input = body as Record<string, unknown>;
    if (
      typeof input.mutationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.mutationId)
    )
      throw new BadRequestException('Invalid mutationId');
    return this.createComment.execute(
      postId(id),
      commentInput({ content: input.content }),
      authorId,
      input.mutationId,
    );
  }
}

function requireSingleAuthorization(rawHeaders: string[]): void {
  // Node가 중복 Authorization 중 하나를 버리기 전에 원래 필드 수를 확인한다.
  if (
    rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length !== 1
  )
    throw new UnauthorizedException('Exactly one service token required');
}
