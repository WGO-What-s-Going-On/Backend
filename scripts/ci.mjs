import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, selectChanges, services } from './ci-lib.mjs';

const formatExtensions =
  /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|jsonc|ya?ml|css|scss|html)$/i;
const [command, ...args] = process.argv.slice(2);
const [base, head = 'HEAD'] = args.filter((argument) => argument !== '--pr');
let files = [];
let all = !base;
if (base) {
  try {
    files = changedFiles(base, head, { pullRequest: args.includes('--pr') });
  } catch {
    // Deleted force-push history must broaden validation rather than silently skip it.
    console.warn(
      'Comparison commit unavailable; validating the entire repository.',
    );
    all = true;
  }
}

function run(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (command === 'detect') {
  for (const group of ['gateways', 'services']) {
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      const path = join(group, entry.name);
      if (
        entry.isDirectory() &&
        existsSync(join(path, 'package.json')) &&
        !services.some((service) => service.path === path)
      )
        throw new Error(
          `${path} must be registered in scripts/ci-services.json`,
        );
    }
  }
  const output =
    Object.entries(selectChanges(files, { all }))
      .map(
        ([name, value]) =>
          `${name}=${typeof value === 'object' ? JSON.stringify(value) : value}`,
      )
      .join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
} else if (command === 'format') {
  if (all || files.some((file) => /^\.prettier(?:rc\.json|ignore)$/.test(file)))
    run('npm', ['run', 'format:check']);
  else {
    const selected = files.filter(
      (file) => existsSync(file) && formatExtensions.test(file),
    );
    if (selected.length)
      run('node_modules/.bin/prettier', ['--check', ...selected]);
    else console.log('No changed files supported by Prettier.');
  }
} else
  throw new Error(
    'Usage: node scripts/ci.mjs detect|format [base-sha] [head-sha] [--pr]',
  );
