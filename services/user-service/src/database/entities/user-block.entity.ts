import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { UserEntity } from './user.entity.js';

@Entity({ name: 'user_blocks' })
@Check('chk_user_blocks_not_self', '"blocker_user_id" <> "blocked_user_id"')
export class UserBlockEntity {
  @PrimaryColumn({
    name: 'blocker_user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_blocks',
  })
  blockerUserId!: string;

  @PrimaryColumn({
    name: 'blocked_user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_blocks',
  })
  blockedUserId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({
    name: 'blocker_user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_blocks_blocker_user_id',
  })
  blockerUser!: UserEntity;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({
    name: 'blocked_user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_blocks_blocked_user_id',
  })
  blockedUser!: UserEntity;
}
