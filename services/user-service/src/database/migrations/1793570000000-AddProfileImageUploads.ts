import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileImageUploads1793570000000 implements MigrationInterface {
  name = 'AddProfileImageUploads1793570000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE profile_image_uploads (
      id uuid PRIMARY KEY,
      owner_id bigint NOT NULL REFERENCES users(id),
      upload_key varchar(500) NOT NULL UNIQUE,
      object_key varchar(500) NOT NULL UNIQUE,
      content_type varchar(30) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
      size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
      checksum varchar(44) NOT NULL,
      status varchar(20) NOT NULL CONSTRAINT chk_profile_image_state CHECK (status IN ('PENDING', 'VERIFIED', 'APPLIED', 'EXPIRED')),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      verified_at timestamptz,
      applied_at timestamptz,
      retired_at timestamptz,
      cleanup_at timestamptz NOT NULL
    )`);
    await queryRunner.query(
      'CREATE INDEX ix_profile_image_cleanup ON profile_image_uploads(cleanup_at)',
    );
    await queryRunner.query(
      'CREATE INDEX ix_profile_image_owner ON profile_image_uploads(owner_id)',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE profile_image_uploads');
  }
}
