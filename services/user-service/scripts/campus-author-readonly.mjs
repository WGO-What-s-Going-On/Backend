// Run in the existing User Service environment, never against Post's database.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

async function main() {
  if (
    !process.env.DB_HOST ||
    !process.env.DB_USER ||
    process.env.DB_NAME !== 'wgo_user'
  )
    throw new Error('Explicit User Service connection required');
  const { databaseTls } = await import(
    pathToFileURL(resolve('dist/database/tls.js')).href
  );
  const { databasePassword } = await import(
    pathToFileURL(resolve('dist/database/auth.js')).href
  );
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: databasePassword(),
    database: process.env.DB_NAME,
    ssl: databaseTls(),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const rows = (
        await client.query(
          'SELECT id::text AS "authorId", nickname, status FROM users WHERE nickname=$1 LIMIT 2',
          ['머준'],
        )
      ).rows;
      if (
        rows.length !== 1 ||
        rows[0].status !== 'ACTIVE' ||
        !/^[1-9]\d*$/.test(rows[0].authorId) ||
        !Number.isSafeInteger(Number(rows[0].authorId))
      )
        throw new Error('Cannot uniquely identify the approved active author');
      await client.query('COMMIT');
      console.log(JSON.stringify({ ...rows[0], readOnly: true }));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Approved author lookup failed; no data changed and private diagnostics suppressed.',
  );
  process.exitCode = 1;
});
