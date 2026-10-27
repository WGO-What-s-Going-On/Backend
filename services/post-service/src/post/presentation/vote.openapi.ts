import { ApiProperty } from '@nestjs/swagger';

export class VoteBody {
  @ApiProperty({ example: 'comment_123e4567-e89b-12d3-a456-426614174000' })
  commentId!: string;
}

export class VoteCandidateResponse {
  @ApiProperty() commentId!: string;
  @ApiProperty() content!: string;
  @ApiProperty() scoreAtSelection!: number;
  @ApiProperty() votes!: number;
}

export class VoteResponse {
  @ApiProperty({ enum: ['PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'NONE'] })
  status!: string;
  @ApiProperty({ type: () => [VoteCandidateResponse] })
  candidates!: VoteCandidateResponse[];
  @ApiProperty({ nullable: true }) selectedAt!: Date | null;
  @ApiProperty({ nullable: true }) closedAt!: Date | null;
  @ApiProperty({ type: () => VoteCandidateResponse, nullable: true })
  winner!: VoteCandidateResponse | null;
  @ApiProperty({ nullable: true }) mySelection!: string | null;
}
