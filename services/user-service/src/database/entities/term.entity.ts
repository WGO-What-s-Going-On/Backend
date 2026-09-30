import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'terms' })
@Unique('uq_terms_code_version', ['code', 'version'])
@Index('idx_terms_code_effective_at', { synchronize: false })
export class TermEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'BY DEFAULT',
    primaryKeyConstraintName: 'pk_terms',
  })
  id!: string;

  @Column({ type: 'varchar' })
  code!: string;

  @Column({ type: 'varchar' })
  version!: string;

  @Column({ type: 'boolean' })
  required!: boolean;

  @Column({ name: 'document_url', type: 'varchar' })
  documentUrl!: string;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
