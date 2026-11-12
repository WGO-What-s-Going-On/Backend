import { CoverFocusBody, DisplayPositionBody } from './post.openapi.js';
import { ApiProperty } from '@nestjs/swagger';
import type { PostStatus } from '../domain/post.js';

export class ActivityLevelResponse {
  @ApiProperty({ type: 'integer', minimum: 0 }) participation!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) agreeReceived!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) picks!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) score!: number;
  @ApiProperty({ type: 'integer', enum: [1, 2, 3, 4] }) level!: number;
  @ApiProperty({ enum: ['소식통', '리포터', '특파원', '천리안'] })
  title!: string;
}

export class RankingItemResponse {
  @ApiProperty({ type: 'integer', minimum: 1 }) rank!: number;
  @ApiProperty({ type: 'integer', minimum: 1 }) userId!: number;
  @ApiProperty({ type: String, nullable: true }) authorNickname!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) picks!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) score!: number;
}

export class RankingResponse {
  @ApiProperty({ pattern: '^[0-9]{10}$', example: '1159053000' })
  regionCode!: string;
  @ApiProperty({ type: () => [RankingItemResponse], maxItems: 100 })
  items!: RankingItemResponse[];
  @ApiProperty({ type: 'integer', minimum: 1, nullable: true }) myRank!:
    | number
    | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) myScore!: number;
}

export class ActivityItemResponse {
  @ApiProperty({ type: DisplayPositionBody, nullable: true })
  displayPosition!: DisplayPositionBody | null;
  @ApiProperty({ type: CoverFocusBody, nullable: true })
  coverFocus!: CoverFocusBody | null;
  @ApiProperty({
    enum: ['POST', 'COMMENT', 'REACTION', 'COMMENT_REACTION', 'VOTE'],
  })
  kind!: string;
  @ApiProperty() postId!: string;
  @ApiProperty({
    enum: ['ACTIVE', 'EXPIRED'],
    description:
      'Current stored status of the parent post. Deleted posts are excluded.',
  })
  postStatus!: Extract<PostStatus, 'ACTIVE' | 'EXPIRED'>;
  @ApiProperty({ type: String, nullable: true }) commentId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Parent post author-closure time. Null does not mean the post is unexpired.',
  })
  closedAt!: string | null;
}

export class ActivityPageResponse {
  @ApiProperty({ type: () => [ActivityItemResponse], maxItems: 20 })
  items!: ActivityItemResponse[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor. Null when there is no next page.',
  })
  nextCursor!: string | null;
}
