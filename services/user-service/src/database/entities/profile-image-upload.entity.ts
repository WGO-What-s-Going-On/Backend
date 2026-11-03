import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type ProfileImageState = 'PENDING' | 'VERIFIED' | 'APPLIED' | 'EXPIRED';

@Entity({ name: 'profile_image_uploads' })
@Check(
  'chk_profile_image_state',
  `"status" IN ('PENDING', 'VERIFIED', 'APPLIED', 'EXPIRED')`,
)
@Index('ix_profile_image_cleanup', ['cleanupAt'])
export class ProfileImageUploadEntity {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ name: 'owner_id', type: 'bigint' }) ownerId!: string;
  @Column({ name: 'upload_key', type: 'varchar', length: 500, unique: true })
  uploadKey!: string;
  @Column({ name: 'object_key', type: 'varchar', length: 500, unique: true })
  objectKey!: string;
  @Column({ name: 'content_type', type: 'varchar', length: 30 })
  contentType!: string;
  @Column({ name: 'size_bytes', type: 'integer' }) sizeBytes!: number;
  @Column({ type: 'varchar', length: 44 }) checksum!: string;
  @Column({ type: 'varchar', length: 20 }) status!: ProfileImageState;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' }) expiresAt!: Date;
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;
  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;
  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;
  @Column({ name: 'cleanup_at', type: 'timestamptz' }) cleanupAt!: Date;
}
