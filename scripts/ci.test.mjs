import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { successfulBase } from './ci-base.mjs';
import { changedFiles, selectChanges, services } from './ci-lib.mjs';

const temporary = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const names = (matrix) => matrix.include.map((service) => service.name).sort();
test('service implementation deploys only its owner but validates affected consumers', () => {
  const selected = selectChanges([
    'services/user-service/src/auth/auth.service.ts',
  ]);
  assert.deepEqual(names(selected.deploy_matrix), ['user-service']);
  assert.deepEqual(names(selected.matrix), ['http-gateway', 'user-service']);
  assert.equal(selected.integration_user_gateway, true);
});
test('tests do not deploy and unrelated docs do not run service jobs', () => {
  assert.deepEqual(
    names(selectChanges(['services/map-service/test/location.test.ts']).matrix),
    ['map-service'],
  );
  assert.equal(
    selectChanges(['services/map-service/test/location.test.ts']).has_deploy,
    false,
  );
  assert.equal(
    selectChanges([
      'docs/architecture/note.md',
      'services/map-service/README.md',
    ]).has_services,
    false,
  );
});
test('RPC contracts validate both participants without deploying the unchanged consumer', () => {
  const selected = selectChanges([
    'services/map-service/contracts/map-authorization.proto',
  ]);
  assert.deepEqual(names(selected.matrix), ['map-service', 'post-service']);
  assert.deepEqual(names(selected.deploy_matrix), ['map-service']);
});
test('event producer contracts validate every known consumer', () => {
  const selected = selectChanges([
    'services/post-service/src/post/infrastructure/post-event-envelope.ts',
  ]);
  assert.deepEqual(names(selected.matrix), [
    'map-service',
    'moderation-service',
    'notification-service',
    'post-service',
    'ws-gateway',
  ]);
  assert.deepEqual(names(selected.deploy_matrix), ['post-service']);
});
test('pipeline configuration validates all without forcing application deployments', () => {
  const selected = selectChanges(['scripts/ci-services.json']);
  assert.equal(selected.matrix.include.length, services.length);
  assert.equal(selected.has_deploy, false);
});
test('shared runtime changes and manual full runs include all services', () => {
  for (const selected of [
    selectChanges(['packages/contracts/event.ts']),
    selectChanges([], { all: true }),
  ]) {
    assert.equal(selected.matrix.include.length, services.length);
    assert.equal(selected.deploy_matrix.include.length, services.length);
    assert.equal(selected.integration_user_gateway, true);
  }
});
test('Dockerfile-only changes build only the changed service image', () => {
  const selected = selectChanges(['gateways/ws-gateway/Dockerfile']);
  assert.deepEqual(names(selected.matrix), ['ws-gateway']);
  assert.deepEqual(names(selected.deploy_matrix), ['ws-gateway']);
  assert.equal(selected.matrix.include[0].build_image, true);
});
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'wgo-ci-'));
  temporary.push(cwd);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI test');
  git('config', 'user.email', 'ci@example.invalid');
  const file = (path, text = path) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, file, commit };
}
test('push comparison retains all commits and deleted runtime files', () => {
  const repo = repository();
  repo.file('services/user-service/src/old.ts');
  const base = repo.commit();
  repo.file('services/map-service/src/main.ts');
  repo.commit();
  rmSync(join(repo.cwd, 'services/user-service/src/old.ts'));
  repo.commit();
  assert.deepEqual(changedFiles(base, 'HEAD', { cwd: repo.cwd }).sort(), [
    'services/map-service/src/main.ts',
    'services/user-service/src/old.ts',
  ]);
});
test('cross-service rename includes both old and new paths', () => {
  const repo = repository();
  repo.file('services/user-service/src/old.ts');
  const base = repo.commit();
  mkdirSync(join(repo.cwd, 'services/map-service/src'), { recursive: true });
  renameSync(
    join(repo.cwd, 'services/user-service/src/old.ts'),
    join(repo.cwd, 'services/map-service/src/new.ts'),
  );
  repo.commit();
  const files = changedFiles(base, 'HEAD', { cwd: repo.cwd });
  assert.deepEqual(names(selectChanges(files).deploy_matrix), [
    'map-service',
    'user-service',
  ]);
});
test('PR comparison uses merge base, excluding unrelated base-branch changes', () => {
  const repo = repository();
  repo.file('README.md');
  repo.commit();
  repo.git('checkout', '-b', 'feature');
  repo.file('services/user-service/src/new.ts');
  const head = repo.commit();
  repo.git('checkout', 'main');
  repo.file('services/map-service/src/unrelated.ts');
  const base = repo.commit();
  assert.deepEqual(
    changedFiles(base, head, { cwd: repo.cwd, pullRequest: true }),
    ['services/user-service/src/new.ts'],
  );
});
test('new branch compares against empty tree, unknown revision throws', () => {
  const repo = repository();
  repo.file('services/map-service/src/main.ts');
  repo.commit();
  assert.deepEqual(changedFiles('0'.repeat(40), 'HEAD', { cwd: repo.cwd }), [
    'services/map-service/src/main.ts',
  ]);
  assert.throws(() =>
    changedFiles('missing-revision', 'HEAD', { cwd: repo.cwd }),
  );
});
test('new application must be explicitly registered', () => {
  const repo = repository();
  mkdirSync(join(repo.cwd, 'gateways'));
  repo.file('services/new-service/package.json', '{}');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./ci.mjs', import.meta.url)), 'detect'],
    { cwd: repo.cwd, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be registered/);
});

test('Post HTTP controller changes validate WS and location contracts', () => {
  const selected = selectChanges([
    'services/post-service/src/post/post.controller.ts',
  ]);
  assert.deepEqual(names(selected.matrix), [
    'map-service',
    'post-service',
    'ws-gateway',
  ]);
  assert.deepEqual(names(selected.deploy_matrix), ['post-service']);
});

test('push baseline uses an ancestral successful run rather than the previous failed commit', () => {
  const first = 'a'.repeat(40),
    failed = 'b'.repeat(40),
    unrelated = 'c'.repeat(40);
  const run = (head_sha, conclusion = 'success', head_branch = 'main') => ({
    head_sha,
    conclusion,
    head_branch,
    event: 'push',
  });
  assert.equal(
    successfulBase([run(failed, 'failure'), run(unrelated), run(first)], {
      branch: 'main',
      head: 'HEAD',
      isAncestor: (sha) => sha === first,
    }),
    first,
  );
  assert.equal(
    successfulBase([run(first, 'success', 'other')], {
      branch: 'main',
      head: 'HEAD',
      isAncestor: () => true,
    }),
    '',
  );
});
test('WS source and Map participation policy run the cross-service regression', () => {
  for (const file of [
    'gateways/ws-gateway/src/app.ts',
    'services/map-service/src/location.ts',
  ]) {
    assert.equal(selectChanges([file]).integration_ws_post, true);
  }
});
