import { ApiProperty } from '@nestjs/swagger';

export class VoteBody {
  @ApiProperty({
    example: 'comment_123e4567-e89b-12d3-a456-426614174000',
    description:
      'Existing candidate selection key. Only the three reserved campus balance boards use option_A / option_B; these are not comment records.',
  })
  commentId!: string;
}

export class VoteCandidateResponse {
  @ApiProperty({
    description:
      'Candidate key; reserved balance choices use option_A / option_B without creating comments.',
  })
  commentId!: string;
  @ApiProperty() content!: string;
  @ApiProperty() scoreAtSelection!: number;
  @ApiProperty() votes!: number;
  @ApiProperty({
    required: false,
    description: '선정 당시 전체 댓글 반응 수. 이전 투표에는 없을 수 있다.',
  })
  totalReactionsAtSelection?: number;
}

export class VoteResponse {
  @ApiProperty({ enum: ['PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'NONE'] })
  status!: string;
  @ApiProperty({ type: () => [VoteCandidateResponse] })
  candidates!: VoteCandidateResponse[];
  @ApiProperty({ nullable: true, description: '선정 당시 게시물 조회수' })
  viewCountAtSelection!: number | null;
  @ApiProperty({ nullable: true }) selectedAt!: Date | null;
  @ApiProperty({ nullable: true }) closedAt!: Date | null;
  @ApiProperty({ type: () => VoteCandidateResponse, nullable: true })
  winner!: VoteCandidateResponse | null;
  @ApiProperty({ nullable: true }) mySelection!: string | null;
}
