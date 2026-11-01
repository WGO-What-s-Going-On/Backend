import { ApiProperty } from '@nestjs/swagger';
export class SimilarPostItem {
  @ApiProperty() postId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ maxLength: 160 }) excerpt!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ minimum: 0, maximum: 150 }) distanceM!: number;
  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      '코사인 유사도를 0~1로 제한한 뒤 100을 곱하고 소수 둘째 자리까지 반올림한 표시값. 중복 확률이 아닙니다.',
  })
  similarityPercent!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class SimilarScope {
  @ApiProperty({ enum: [150] }) radiusM!: number;
  @ApiProperty({ enum: [24] }) lookbackHours!: number;
}
export class SimilarPostsResponse {
  @ApiProperty({ type: [SimilarPostItem], maxItems: 3 })
  items!: SimilarPostItem[];
  @ApiProperty({ enum: ['completed', 'partial'] }) checkStatus!: string;
  @ApiProperty({ enum: ['INDEX_LAG', 'CANDIDATE_LIMIT'], isArray: true })
  partialReasons!: string[];
  @ApiProperty({ type: SimilarScope }) scope!: SimilarScope;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
}
