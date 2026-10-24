import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Post semantic tests require a successful Map install and build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wgo-ci-run-'));
  const log = join(dir, 'commands.jsonl');
  try {
    writeFileSync(
      join(dir, 'pnpm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const entry = { cwd: process.cwd(), args: process.argv.slice(2), semantic: process.env.RUN_SEMANTIC_INTEGRATION };
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(entry) + '\\n');
if (process.env.FAIL_MAP === '1' && entry.cwd.endsWith('/map-service') && entry.args.includes('build')) process.exit(9);
`,
      { mode: 0o755 },
    );
    const run = (fail) =>
      spawnSync(process.execPath, ['scripts/ci-run.mjs', 'post-service'], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          COMMAND_LOG: log,
          FAIL_MAP: fail,
        },
        encoding: 'utf8',
      });
    assert.equal(run('0').status, 0);
    const entries = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.ok(entries[0].cwd.endsWith('/map-service'));
    assert.deepEqual(entries[0].args, ['install', '--frozen-lockfile']);
    assert.ok(entries[1].cwd.endsWith('/map-service'));
    assert.deepEqual(entries[1].args, ['run', 'build']);
    assert.ok(
      entries.some(
        (e) =>
          e.cwd.endsWith('/post-service') &&
          e.args[1] === 'test' &&
          e.semantic === '1',
      ),
    );
    writeFileSync(log, '');
    assert.equal(run('1').status, 9);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
