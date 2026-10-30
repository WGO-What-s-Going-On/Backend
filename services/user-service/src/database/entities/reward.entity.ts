import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

// These tables use explicit SQL for conditional upserts and transaction locks.
// Entity metadata keeps their bigint/string boundaries visible to TypeORM callers.
@Entity({ name: 'user_activities' })
export class UserActivityEntity {
  @PrimaryColumn({ name: 'activity_key', type: 'text' }) activityKey!: string;
  @Column({ name: 'post_id', type: 'text' }) postId!: string;
  @Column({ type: 'text' }) kind!: string;
  @Column({ name: 'comment_id', type: 'text', nullable: true }) commentId!:
    | string
    | null;
  @Column({ name: 'result_id', type: 'text', nullable: true }) resultId!:
    | string
    | null;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt!: Date;
  @Column({ name: 'source_time_verified', type: 'boolean' })
  sourceTimeVerified!: boolean;
  @Column({ name: 'actor_id', type: 'bigint' }) actorId!: string;
  @Column({ name: 'beneficiary_id', type: 'bigint', nullable: true })
  beneficiaryId!: string | null;
  @Column({ name: 'reaction_type', type: 'text', nullable: true })
  reactionType!: string | null;
  @Column({ type: 'bigint' }) version!: string;
  @Column({ type: 'boolean' }) active!: boolean;
  @Column({ name: 'event_id', type: 'text' }) eventId!: string;
  @Column({ name: 'correlation_id', type: 'text' }) correlationId!: string;
  @Column({ type: 'text' }) eligibility!: string;
  @Column({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
@Entity({ name: 'user_growth' })
export class UserGrowthEntity {
  @PrimaryColumn({ name: 'user_id', type: 'bigint' }) userId!: string;
  @Column({ type: 'bigint' }) credits!: string;
  @Column({ name: 'growth_score', type: 'bigint' }) growthScore!: string;
  @Column({ type: 'integer', nullable: true }) level!: number | null;
  @Column({ name: 'policy_version', type: 'text', nullable: true })
  policyVersion!: string | null;
}
@Entity({ name: 'credit_ledger' })
export class CreditLedgerEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id!: string;
  @Column({ name: 'user_id', type: 'bigint' }) userId!: string;
  @Column({ name: 'activity_key', type: 'text' }) activityKey!: string;
  @Column({ name: 'event_id', type: 'text' }) eventId!: string;
  @Column({ name: 'policy_version', type: 'text' }) policyVersion!: string;
  @Column({ type: 'bigint' }) credits!: string;
  @Column({ type: 'bigint' }) growth!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
