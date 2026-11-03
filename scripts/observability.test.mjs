import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  writeLog,
  safeError,
  requestContext,
  withLogContext,
  getLogContext,
  correlationHeaders,
} from '../shared/observability/logging.ts';

test('logging copies cannot drift from canonical source', () => {
  execFileSync(process.execPath, ['scripts/sync-observability.mjs', '--check']);
});
test('structured failure has severity, ownership, safe code and no provider credentials', () => {
  let output;
  writeLog(
    'post-service',
    'vote',
    {
      event: 'vote.open.failed',
      message: 'Vote opening failed',
      outcome: 'failure',
      error: safeError(
        new Error('password=super-secret private comment'),
        'VOTE_OPEN_FAILED',
        'Vote opening failed',
      ),
      postId: 'post_123',
      token: 'secret',
      body: 'private comment',
      coordinates: [12, 34],
    },
    undefined,
    (line) => {
      output = JSON.parse(line);
    },
  );
  assert.equal(output.severity, 'ERROR');
  assert.equal(output.service, 'post-service');
  assert.equal(output.domain, 'vote');
  assert.equal(output.error.code, 'VOTE_OPEN_FAILED');
  assert.equal(output.postId, 'post_123');
  assert.doesNotMatch(
    JSON.stringify(output),
    /super-secret|private comment|coordinates|"token"/,
  );
});
test('context survives async work and isolates concurrent requests', async () => {
  await Promise.all(
    ['first', 'second'].map((requestId) =>
      withLogContext({ requestId, correlationId: requestId }, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(getLogContext().requestId, requestId);
        assert.equal(correlationHeaders()['x-correlation-id'], requestId);
      }),
    ),
  );
  assert.deepEqual(getLogContext(), {});
});
test('untrusted request IDs are replaced and path queries are removed', () => {
  const context = requestContext({ 'x-request-id': 'cookie=private\nvalue' });
  assert.match(context.requestId, /^[a-f0-9-]{36}$/);
  let output;
  writeLog(
    'http-gateway',
    'auth',
    {
      event: 'http.request.completed',
      message: 'Completed',
      outcome: 'success',
      path: '/api/auth?token=secret',
    },
    undefined,
    (line) => {
      output = JSON.parse(line);
    },
  );
  assert.equal(output.path, '/api/auth');
});
test('telemetry sink failure does not fail committed business work', () => {
  assert.doesNotThrow(() =>
    writeLog(
      'post-service',
      'vote',
      { event: 'vote.opened', message: 'Vote opened', outcome: 'success' },
      undefined,
      () => {
        throw new Error('sink unavailable');
      },
    ),
  );
});
test('debug no-op logs are suppressed by default and explicit levels work', () => {
  const previous = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  const lines = [];
  try {
    const entry = {
      event: 'worker.empty',
      message: 'No work',
      outcome: 'skipped',
      reasonCode: 'EMPTY',
    };
    writeLog('post-service', 'vote', entry, 'DEBUG', (line) =>
      lines.push(line),
    );
    assert.equal(lines.length, 0);
    process.env.LOG_LEVEL = 'DEBUG';
    writeLog('post-service', 'vote', entry, 'DEBUG', (line) =>
      lines.push(line),
    );
    assert.equal(lines.length, 1);
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});
