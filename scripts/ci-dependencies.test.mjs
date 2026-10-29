import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t, service = 'post-service') {
  const dir = mkdtempSync(join(tmpdir(), 'wgo-ci-dependencies-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'commands.jsonl');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const tool = require('node:path').basename(process.argv[1]);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ tool, args }) + '\\n');
if (args.includes(process.env.FAIL_COMMAND)) process.exit(7);
if (args.includes('ps') && args.includes('-q')) { console.log('abcdef123456'); process.exit(0); }
if (args.includes('logs')) {
  console.log('mongo: simulated startup failure');
  if (process.env.FAIL_DIAGNOSTICS === '1') process.exit(9);
}
if (args.includes('inspect')) console.log('{"ExitCode":1,"OOMKilled":false,"Error":"","Health":{"Status":"unhealthy"}}');
if (tool === 'free' || tool === 'df') console.log('simulated runner resource snapshot');
`;
  for (const tool of ['docker', 'free', 'df'])
    writeFileSync(join(dir, tool), fake, { mode: 0o755 });
  return (command, env = {}) => {
    writeFileSync(log, '');
    const result = spawnSync(
      process.execPath,
      ['scripts/ci-dependencies.mjs', command, service],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          COMMAND_LOG: log,
          FAIL_COMMAND: 'never',
          ...env,
        },
        encoding: 'utf8',
      },
    );
    const entries = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    return { ...result, entries, output: result.stdout + result.stderr };
  };
}

test('dependency startup failure collects logs and state before workflow cleanup', (t) => {
  const run = fixture(t);
  const result = run('start', { FAIL_COMMAND: 'up' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /simulated startup failure/);
  assert.match(result.output, /OOMKilled/);
  assert.ok(result.entries.some((e) => e.tool === 'free'));
  assert.ok(result.entries.some((e) => e.tool === 'df'));
  assert.ok(
    result.entries.some(
      (e) => e.args.includes('inspect') && e.args.includes('--format'),
    ),
  );
  assert.ok(!result.entries.some((e) => e.args.includes('down')));
});

test('initialization failure also collects diagnostics and diagnostic failure preserves original exit', (t) => {
  const run = fixture(t);
  const result = run('start', { FAIL_COMMAND: 'exec', FAIL_DIAGNOSTICS: '1' });
  assert.equal(result.status, 7);
  assert.match(result.output, /CI dependency command failed \(7\)/);
  assert.match(result.output, /OOMKilled/);
  assert.ok(result.entries.some((e) => e.tool === 'df'));
});

test('successful startup and stop keep their existing commands without diagnostics', (t) => {
  const run = fixture(t);
  const started = run('start');
  assert.equal(started.status, 0, started.output);
  assert.equal(started.entries.length, 3);
  assert.ok(started.entries[0].args.includes('up'));
  assert.ok(started.entries[1].args.includes('mongosh'));
  assert.ok(started.entries[2].args.includes('cqlsh'));
  const stopped = run('stop');
  assert.equal(stopped.status, 0);
  assert.equal(stopped.entries.length, 1);
  assert.deepEqual(stopped.entries[0].args.slice(-3), [
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
});

test('Moderation provisions PostgreSQL and Redis before report integration tests', (t) => {
  const run = fixture(t, 'moderation-service');
  const started = run('start');
  assert.equal(started.status, 0, started.output);
  assert.equal(started.entries.length, 1);
  const args = started.entries[0].args;
  assert.deepEqual(args.slice(args.indexOf('up')), [
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '360',
    'postgres',
    'redis6383',
  ]);
  const stopped = run('stop');
  assert.equal(stopped.status, 0);
  assert.deepEqual(stopped.entries[0].args.slice(-3), [
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
});
