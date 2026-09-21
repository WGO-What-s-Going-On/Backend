import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const formatExtensions =
  /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|jsonc|ya?ml|css|scss|html)$/i;
const globalPaths =
  /^(?:\.github\/workflows\/|scripts\/ci\.mjs$|package(?:-lock)?\.json$|pnpm-(?:lock|workspace)\.yaml$|\.npmrc$|\.prettier(?:rc\.json|ignore)$|\.gitignore$|shared\/|packages\/)/;

function changedFiles(base) {
  if (!base) throw new Error('A base commit SHA is required');
  const from = /^0+$/.test(base) ? emptyTree : base;
  return execFileSync('git', ['diff', '--name-only', '-z', from, 'HEAD'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function services() {
  return ['gateways', 'services'].flatMap((group) => {
    if (!existsSync(group)) return [];
    return readdirSync(group, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(group, entry.name) }))
      .filter((service) => existsSync(join(service.path, 'package.json')));
  });
}

const [command, base] = process.argv.slice(2);
const files = command === 'detect' && !base ? [] : changedFiles(base);

if (command === 'detect') {
  const changedServices = files
    .map((file) => file.match(/^(gateways|services)\/([^/]+)\//))
    .filter(Boolean)
    .map((match) => `${match[1]}/${match[2]}`);
  for (const path of new Set(changedServices)) {
    if (existsSync(path) && !existsSync(join(path, 'package.json'))) {
      throw new Error(`${path} needs a package.json to run Vitest in CI`);
    }
  }
  const all = !base || files.some((file) => globalPaths.test(file));
  const selected = services().filter(
    (service) =>
      all || files.some((file) => file.startsWith(`${service.path}/`)),
  );
  const output = `matrix=${JSON.stringify({ include: selected })}\nhas_services=${selected.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
} else if (command === 'format') {
  if (files.some((file) => /^\.prettier(?:rc\.json|ignore)$/.test(file))) {
    const result = spawnSync('npm', ['run', 'format:check'], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    const selected = files.filter(
      (file) => existsSync(file) && formatExtensions.test(file),
    );
    if (selected.length === 0) {
      console.log('No changed files supported by Prettier.');
    } else {
      const result = spawnSync(
        'node_modules/.bin/prettier',
        ['--check', ...selected],
        {
          stdio: 'inherit',
        },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  }
} else {
  throw new Error('Usage: node scripts/ci.mjs detect|format <base-sha>');
}
