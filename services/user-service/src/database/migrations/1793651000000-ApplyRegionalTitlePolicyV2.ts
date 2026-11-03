import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ApplyRegionalTitlePolicyV21793651000000
  implements MigrationInterface
{
  name = 'ApplyRegionalTitlePolicyV21793651000000';
  async up(q: QueryRunner): Promise<void> {
    // PostgreSQL truncates auto-generated identifiers; locate the old key by its
    // columns rather than depending on the server's generated constraint name.
    const keys: Array<{ conname: string }> =
      await q.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='regional_ranking_runs'::regclass AND contype='u'
        AND pg_get_constraintdef(oid)='UNIQUE (region_code, ranking_date, input_revision)'`);
    if (keys.length !== 1)
      throw new Error('Expected the legacy regional ranking revision key');
    await q.query(
      `ALTER TABLE regional_ranking_runs DROP CONSTRAINT "${keys[0]!.conname.replaceAll('"', '""')}"`,
    );
    await q.query(`
      ALTER TABLE regional_ranking_runs ADD CONSTRAINT uq_regional_ranking_policy_revision
        UNIQUE(region_code,ranking_date,input_revision,policy_version);
      UPDATE regional_ranking_state SET input_revision=input_revision+1 WHERE singleton=true;
    `);
    // Existing v1 definitions, runs, entries and badge history remain immutable.
    // The runtime inserts/checks the distinct v2 definition before its first evaluation.
  }
  async down(): Promise<void> {
    throw new Error(
      'Regional title policy history requires a forward migration',
    );
  }
}
