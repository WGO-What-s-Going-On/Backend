import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  WITHDRAWAL_PENDING = 'WITHDRAWAL_PENDING',
  WITHDRAWN = 'WITHDRAWN',
}

@Entity({ name: 'users' })
@Check(
  'chk_users_status',
  `"status" IN ('ACTIVE', 'SUSPENDED', 'WITHDRAWAL_PENDING', 'WITHDRAWN')`,
)
@Index('uq_users_nickname_lower', { synchronize: false })
export class UserEntity {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_users' })
  id!: string;

  @Column({ type: 'varchar', length: 30 })
  nickname!: string;

  @Column({ name: 'profile_image_key', type: 'varchar', length: 500, nullable: true })
  profileImageKey!: string | null;

  @Column({ type: 'varchar', length: 30 })
  status!: UserStatus;

  @Column({ name: 'suspended_until', type: 'timestamptz', nullable: true })
  suspendedUntil!: Date | null;

  @Column({ name: 'withdrawal_requested_at', type: 'timestamptz', nullable: true })
  withdrawalRequestedAt!: Date | null;

  @Column({ name: 'withdrawal_deadline_at', type: 'timestamptz', nullable: true })
  withdrawalDeadlineAt!: Date | null;

  @Column({ name: 'withdrawn_at', type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @Column({ name: 'onboarding_completed_at', type: 'timestamptz', nullable: true })
  onboardingCompletedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
