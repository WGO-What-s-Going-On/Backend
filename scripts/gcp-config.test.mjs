import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runtime from '../deploy/gke/runtime.cjs';

test('mounted secret becomes child environment without changing parent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wgo-runtime-'));
  try {
    const file = join(dir, 'runtime.json');
    writeFileSync(
      file,
      JSON.stringify({ DB_USER: 'user', JWT_ACCESS_SECRET: 'private' }),
    );
    const base = { PORT: '3001' };
    assert.deepEqual(runtime.runtimeEnvironment(file, base), {
      ...base,
      DB_USER: 'user',
      JWT_ACCESS_SECRET: 'private',
    });
    assert.deepEqual(base, { PORT: '3001' });
    for (const invalid of [
      [],
      null,
      { PORT: 3001 },
      { NODE_OPTIONS: '--require evil' },
    ]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => runtime.runtimeEnvironment(file, base));
    }
    writeFileSync(file, 'secret-that-must-not-be-logged');
    assert.throws(() => runtime.runtimeEnvironment(file), {
      message: 'Runtime secret must be a readable JSON object',
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runtime wrapper forwards SIGTERM and waits for application drain', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = mkdtempSync(join(tmpdir(), 'wgo-runtime-signal-'));
  const secret = join(dir, 'runtime.json');
  const childFile = join(dir, 'child.cjs');
  writeFileSync(secret, '{}');
  writeFileSync(
    childFile,
    "process.on('SIGTERM',()=>{console.log('drained');process.exit(0)});console.log('ready');setInterval(()=>{},1000)",
  );
  const wrapper = spawn(
    process.execPath,
    ['deploy/gke/runtime.cjs', process.execPath, childFile],
    {
      env: { ...process.env, RUNTIME_SECRET_FILE: secret },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  wrapper.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => wrapper.kill('SIGKILL'), 5000);
  try {
    await once(wrapper.stdout, 'data');
    wrapper.kill('SIGTERM');
    const [code] = await once(wrapper, 'exit');
    assert.equal(code, 0);
    assert.match(output, /drained/);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true });
  }
});
