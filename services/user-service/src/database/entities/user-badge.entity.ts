import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { BadgeEntity } from './badge.entity.js';
import { UserEntity } from './user.entity.js';

@Entity({ name: 'user_badges' })
export class UserBadgeEntity {
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_badges',
  })
  userId!: string;

  @PrimaryColumn({
    name: 'badge_id',
    type: 'bigint',
    primaryKeyConstraintName: 'pk_user_badges',
  })
  badgeId!: string;

  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_badges_user_id',
  })
  user!: UserEntity;

  @ManyToOne(() => BadgeEntity, { nullable: false })
  @JoinColumn({
    name: 'badge_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_badges_badge_id',
  })
  badge!: BadgeEntity;
}
