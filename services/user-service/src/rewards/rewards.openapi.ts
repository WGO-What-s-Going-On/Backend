import { ApiProperty } from '@nestjs/swagger';
export class TitleStageResult {
  @ApiProperty() stage!: number;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() condition!: string;
  @ApiProperty({ type: String }) progress!: string;
  @ApiProperty({ type: String, nullable: true }) required!: string | null;
  @ApiProperty({ type: String, nullable: true }) remaining!: string | null;
  @ApiProperty() qualified!: boolean;
  @ApiProperty() achieved!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  achievedAt!: string | null;
}
export class NextTitleResult {
  @ApiProperty() code!: string;
  @ApiProperty({ type: String, nullable: true }) remaining!: string | null;
}
export class RegionalTitleResult {
  @ApiProperty() regionCode!: string;
  @ApiProperty() regionName!: string;
  @ApiProperty({ type: String, nullable: true }) rankingDate!: string | null;
  @ApiProperty({ type: String }) score!: string;
  @ApiProperty({ type: String, nullable: true }) rank!: string | null;
  @ApiProperty({ type: String }) competitors!: string;
  @ApiProperty({ type: String }) slots!: string;
  @ApiProperty({ type: String, nullable: true }) cutoffScore!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Additional selections to exceed the saved cutoff while all other results stay fixed; not a prediction.',
  })
  additionalSelectionsForGuaranteedEntry!: string | null;
  @ApiProperty() selected!: boolean;
  @ApiProperty() eligible!: boolean;
  @ApiProperty() entryPossible!: boolean;
  @ApiProperty() upToDate!: boolean;
  @ApiProperty({ type: String, nullable: true }) runId!: string | null;
}
export class RegionalTitleReadinessResult {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() ready!: boolean;
  @ApiProperty({
    enum: [
      'DISABLED',
      'CONTRACT_UNAVAILABLE',
      'INCOMPLETE_SOURCE_DATA',
      'READY',
    ],
  })
  status!: string;
  @ApiProperty({ type: String }) missingRegionResults!: string;
  @ApiProperty({ type: String }) unverifiedTimeResults!: string;
  @ApiProperty({ example: 'Asia/Seoul' }) timeZone!: string;
  @ApiProperty({ format: 'date-time' }) nextUpdateAt!: string;
  @ApiProperty({ type: [RegionalTitleResult] }) regions!: RegionalTitleResult[];
}
export class TitleProgressResult {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() policyVersion!: string;
  @ApiProperty() currentStage!: number;
  @ApiProperty() highestAchievedStage!: number;
  @ApiProperty({ type: [TitleStageResult] }) stages!: TitleStageResult[];
  @ApiProperty({ type: NextTitleResult, nullable: true })
  nextTitle!: NextTitleResult | null;
  @ApiProperty({ type: RegionalTitleReadinessResult })
  regionalRanking!: RegionalTitleReadinessResult;
}
export class GrowthResult {
  @ApiProperty({ type: TitleProgressResult }) titles!: TitleProgressResult;
  @ApiProperty({ type: String }) credits!: string;
  @ApiProperty({ type: String }) growthScore!: string;
  @ApiProperty({ type: Number, nullable: true }) level!: number | null;
  @ApiProperty({ type: String, nullable: true }) policyVersion!: string | null;
  @ApiProperty() rewardsEnabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) levelFloor!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextLevelScore!: string | null;
}
export class CreditHistoryItemResult {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty() activityKey!: string;
  @ApiProperty() eventId!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ type: String }) delta!: string;
  @ApiProperty({ type: String }) growthDelta!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class CreditHistoryResult {
  @ApiProperty({ type: [CreditHistoryItemResult] })
  items!: CreditHistoryItemResult[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class BadgeHistoryItemResult {
  @ApiProperty({ type: String, nullable: true }) regionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) rankingRunId!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) badgeId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['GRANTED', 'REVOKED'] }) action!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class BadgeHistoryResult {
  @ApiProperty({ type: [BadgeHistoryItemResult] })
  items!: BadgeHistoryItemResult[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
