import { ApiProperty } from '@nestjs/swagger';
import { CreatePostBody } from './post.openapi.js';
export class SimilarPostsBody extends CreatePostBody {
  @ApiProperty({ required: false, minimum: 1, maximum: 10, default: 5 })
  limit?: number;
}
export class SimilarPostItem {
  @ApiProperty() postId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ maxLength: 160 }) excerpt!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ minimum: 0, maximum: 350 }) distanceM!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class SimilarScope {
  @ApiProperty({ enum: [350] }) radiusM!: number;
  @ApiProperty({ enum: [24] }) lookbackHours!: number;
}
export class SimilarPostsResponse {
  @ApiProperty({ type: [SimilarPostItem], maxItems: 10 })
  items!: SimilarPostItem[];
  @ApiProperty({ enum: ['completed', 'partial'] }) checkStatus!: string;
  @ApiProperty({ enum: ['INDEX_LAG', 'CANDIDATE_LIMIT'], isArray: true })
  partialReasons!: string[];
  @ApiProperty({ type: SimilarScope }) scope!: SimilarScope;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
}
