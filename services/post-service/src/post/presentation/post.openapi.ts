import { ApiProperty } from '@nestjs/swagger';

const postIdExample = 'post_123e4567-e89b-12d3-a456-426614174000';
const dateTime = { type: String, format: 'date-time', example: '2026-09-26T04:00:00.000Z' } as const;

export class CreatePostBody {
  @ApiProperty({ maxLength: 120, example: '현장 상황' }) title!: string;
  @ApiProperty({ maxLength: 5000, example: '현재 교통 상황을 공유합니다.' }) content!: string;
  @ApiProperty({ maxLength: 40, pattern: '^[A-Z][A-Z_]*$', example: 'INCIDENT' }) category!: string;
  @ApiProperty({ minimum: -90, maximum: 90, example: 37.4979 }) latitude!: number;
  @ApiProperty({ minimum: -180, maximum: 180, example: 127.0276 }) longitude!: number;
  @ApiProperty({ minimum: 1, maximum: 10000, example: 250 }) radiusM!: number;
}

export class CreateCommentBody {
  @ApiProperty({ maxLength: 2000, example: '현장 확인했습니다.' }) content!: string;
}

export class InternalCreateCommentBody extends CreateCommentBody {
  @ApiProperty({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', example: 'client-mutation-1' }) mutationId!: string;
}

export class CreateReactionBody {
  @ApiProperty({ enum: ['LIKE'], example: 'LIKE' }) type!: 'LIKE';
}

export class JoinPostBody {}

export class BatchGetBody {
  @ApiProperty({ type: [String], maxItems: 100, example: [postIdExample] }) postIds!: string[];
}

export class LocationResponse {
  @ApiProperty({ example: 37.4979 }) latitude!: number;
  @ApiProperty({ example: 127.0276 }) longitude!: number;
}

export class CountersResponse {
  @ApiProperty({ example: 0 }) viewCount!: number;
  @ApiProperty({ example: 2 }) commentCount!: number;
  @ApiProperty({ example: 1 }) reactionCount!: number;
  @ApiProperty({ example: 3 }) participantCount!: number;
}

export class PostResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ example: 123 }) authorId!: number;
  @ApiProperty({ example: 'INCIDENT' }) category!: string;
  @ApiProperty({ example: '현장 상황' }) title!: string;
  @ApiProperty({ example: '현재 교통 상황을 공유합니다.' }) content!: string;
  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'DELETED'], example: 'ACTIVE' }) status!: string;
  @ApiProperty({ type: () => LocationResponse }) locationSnapshot!: LocationResponse;
  @ApiProperty({ example: 250 }) radiusM!: number;
  @ApiProperty({ type: () => CountersResponse }) counters!: CountersResponse;
  @ApiProperty(dateTime) createdAt!: string;
  @ApiProperty(dateTime) updatedAt!: string;
  @ApiProperty({ ...dateTime, nullable: true, example: null }) expiresAt!: string | null;
}

export class CommentResponse {
  @ApiProperty({ example: 'comment_123e4567-e89b-12d3-a456-426614174000' }) commentId!: string;
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ example: 123 }) authorId!: number;
  @ApiProperty({ example: '현장 확인했습니다.' }) content!: string;
  @ApiProperty({ enum: ['ACTIVE'], example: 'ACTIVE' }) status!: string;
  @ApiProperty(dateTime) createdAt!: string;
  @ApiProperty({ ...dateTime, nullable: true, example: null }) updatedAt!: string | null;
}

export class CommentPageResponse {
  @ApiProperty({ type: () => [CommentResponse] }) comments!: CommentResponse[];
  @ApiProperty({ type: String, nullable: true, description: '다음 페이지가 없으면 null' }) nextCursor!: string | null;
}

export class ReactionResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ example: 123 }) userId!: number;
  @ApiProperty({ enum: ['LIKE'] }) type!: string;
  @ApiProperty(dateTime) createdAt!: string;
}

export class ParticipantResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ example: 123 }) userId!: number;
  @ApiProperty(dateTime) joinedAt!: string;
  @ApiProperty(dateTime) lastSeenAt!: string;
  @ApiProperty({ ...dateTime, nullable: true, example: null }) leftAt!: string | null;
}

export class PostSummaryResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ example: '현장 상황' }) title!: string;
  @ApiProperty({ example: 'INCIDENT' }) category!: string;
  @ApiProperty({ enum: ['ACTIVE'] }) status!: string;
  @ApiProperty(dateTime) createdAt!: string;
}

export class BatchGetResponse {
  @ApiProperty({ type: () => [PostSummaryResponse] }) posts!: PostSummaryResponse[];
}

export class PostMetaResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'DELETED'] }) status!: string;
  @ApiProperty({ example: 'INCIDENT' }) category!: string;
  @ApiProperty({ type: () => LocationResponse }) locationSnapshot!: LocationResponse;
  @ApiProperty({ example: 250 }) radiusM!: number;
  @ApiProperty({ ...dateTime, nullable: true, example: null }) expiresAt!: string | null;
}

export class PostStatusResponse {
  @ApiProperty({ example: postIdExample }) postId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'DELETED'] }) status!: string;
  @ApiProperty({ ...dateTime, nullable: true, example: null }) expiresAt!: string | null;
}
