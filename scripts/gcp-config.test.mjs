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
