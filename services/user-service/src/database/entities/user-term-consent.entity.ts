import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { TermEntity } from './term.entity.js';
import { UserEntity } from './user.entity.js';

@Entity({ name: 'user_term_consents' })
@Unique('uq_user_term_consents_user_id_term_id', ['userId', 'termId'])
export class UserTermConsentEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
    primaryKeyConstraintName: 'pk_user_term_consents',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'term_id', type: 'bigint' })
  termId!: string;

  @Column({ name: 'agreed_at', type: 'timestamptz' })
  agreedAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({
    name: 'user_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_term_consents_user_id',
  })
  user!: UserEntity;

  @ManyToOne(() => TermEntity, { nullable: false })
  @JoinColumn({
    name: 'term_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_user_term_consents_term_id',
  })
  term!: TermEntity;
}
