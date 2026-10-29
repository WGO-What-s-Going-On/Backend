import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddPrivateRealName1793200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE users ADD COLUMN real_name varchar(100)',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE users DROP COLUMN real_name');
  }
}
