import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTermsCodeEffectiveAtIndex1789993249262 implements MigrationInterface {
  name = 'AddTermsCodeEffectiveAtIndex1789993249262';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "idx_terms_code_effective_at"
      ON "terms" ("code", "effective_at" DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_terms_code_effective_at"');
  }
}
