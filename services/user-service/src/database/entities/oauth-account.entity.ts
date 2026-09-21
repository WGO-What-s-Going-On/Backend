import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique } from 'typeorm';

import { UserEntity } from './user.entity.js';

@Entity({ name: 'oauth_accounts' })
@Unique('uq_oauth_accounts_provider_provider_user_id', ['provider', 'providerUserId'])
@Unique('uq_oauth_accounts_user_id_provider', ['userId', 'provider'])
export class OAuthAccountEntity {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_oauth_accounts' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  provider!: string;

  @Column({ name: 'provider_user_id', type: 'varchar' })
  providerUserId!: string;

  @Column({ name: 'provider_email', type: 'varchar', nullable: true })
  providerEmail!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_oauth_accounts_user_id',
  })
  user!: UserEntity;
}
