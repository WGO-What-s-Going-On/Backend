import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { services } from './ci-lib.mjs';

const [name, mode = 'verify'] = process.argv.slice(2);
const service = services.find((entry) => entry.name === name);
if (!service || !['verify', 'install', 'build'].includes(mode))
  throw new Error('Usage: ci-run.mjs <service> [verify|install|build]');
const pkg = JSON.parse(
  readFileSync(join(service.path, 'package.json'), 'utf8'),
);
const manager = existsSync(join(service.path, 'pnpm-lock.yaml'))
  ? 'pnpm'
  : 'npm';
if (manager === 'npm' && !existsSync(join(service.path, 'package-lock.json')))
  throw new Error(`${name} requires a lockfile`);
function run(args, extraEnv = {}) {
  const result = spawnSync(manager, args, {
    cwd: service.path,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === 'install')
  run(manager === 'pnpm' ? ['install', '--frozen-lockfile'] : ['ci']);
else if (mode === 'build') run(['run', 'build']);
else {
  // Semantic tests import Map's compiled modules, including its own dependencies.
  if (name === 'post-service') {
    for (const prerequisite of ['install', 'build']) {
      const result = spawnSync(
        process.execPath,
        ['scripts/ci-run.mjs', 'map-service', prerequisite],
        { stdio: 'inherit', env: process.env },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
  for (const script of ['typecheck', 'lint'])
    if (pkg.scripts?.[script]) run(['run', script]);
  if (!pkg.scripts?.test) throw new Error(`${name} must define test`);
  run(['run', 'test'], {
    RUN_INTEGRATION: '1',
    ...(name === 'post-service' ? { RUN_SEMANTIC_INTEGRATION: '1' } : {}),
  });
  if (pkg.scripts?.['test:integration']) run(['run', 'test:integration']);
  if (pkg.scripts?.build) run(['run', 'build']);
}
