import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const manifest = JSON.parse(
  readFileSync(new URL('./ci-services.json', import.meta.url), 'utf8'),
);
export const services = manifest.services;
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const sharedRuntime = /^(?:shared|packages)\//;
const globalValidation =
  /^(?:\.github\/workflows\/ci\.ya?ml$|scripts\/ci[^/]*\.(?:mjs|json|ya?ml)$|package(?:-lock)?\.json$|pnpm-(?:lock|workspace)\.yaml$|\.npmrc$|\.prettier(?:rc\.json|ignore)$)/;
const documentation =
  /(?:^|\/)(?:README[^/]*|AGENTS\.md|LICENSE[^/]*|\.env(?:\.[^/]*)?)(?:$)|\.(?:md|mdx)$/i;

export function isRuntimeFile(relative) {
  if (documentation.test(relative)) return false;
  if (/^(?:test|tests|__tests__|docs|coverage)\//.test(relative)) return false;
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative))
    return false;
  if (
    /^(?:vitest[^/]*|compose[^/]*|docker-compose[^/]*)\.[^/]+$/.test(relative)
  )
    return false;
  // Unknown non-documentation service assets are conservative runtime candidates.
  return true;
}

export function selectChanges(files, { all = false } = {}) {
  const selected = new Set();
  const deploy = new Set();
  const integrations = new Set();
  const validateAll =
    all ||
    files.some(
      (file) => globalValidation.test(file) || sharedRuntime.test(file),
    );
  if (validateAll) services.forEach((service) => selected.add(service.name));
  if (all || files.some((file) => sharedRuntime.test(file)))
    services.forEach((service) => deploy.add(service.name));
  for (const service of services) {
    const owned = files.filter((file) => file.startsWith(`${service.path}/`));
    if (owned.some((file) => !documentation.test(file)))
      selected.add(service.name);
    if (
      owned.some((file) => isRuntimeFile(file.slice(service.path.length + 1)))
    )
      deploy.add(service.name);
  }
  for (const rule of manifest.contractRules) {
    if (
      all ||
      files.some((file) =>
        rule.prefixes.some((prefix) => file.startsWith(prefix)),
      )
    ) {
      rule.services.forEach((name) => selected.add(name));
      if (rule.integration) integrations.add(rule.integration);
    }
  }
  if (validateAll) {
    integrations.add('user-gateway');
    integrations.add('ws-post');
  }
  return {
    matrix: {
      include: services
        .filter((service) => selected.has(service.name))
        .map((service) => ({
          ...service,
          build_image: deploy.has(service.name),
        })),
    },
    has_services: selected.size > 0,
    deploy_matrix: {
      include: services.filter((service) => deploy.has(service.name)),
    },
    has_deploy: deploy.size > 0,
    integration_user_gateway: integrations.has('user-gateway'),
    integration_ws_post: integrations.has('ws-post'),
  };
}

export function changedFiles(
  base,
  head = 'HEAD',
  { pullRequest = false, cwd = process.cwd() } = {},
) {
  if (!base || !head) throw new Error('Base and head commits are required');
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  // Resolve revisions before diff so an untrusted/invalid ref cannot be interpreted as an option.
  const resolvedHead = git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${head}^{commit}`,
  ]);
  let from = /^0+$/.test(base)
    ? emptyTree
    : git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  if (pullRequest && from !== emptyTree)
    from = git(['merge-base', from, resolvedHead]);
  // A cross-service rename must select both the former owner and the new owner.
  return execFileSync(
    'git',
    ['diff', '--no-renames', '--name-only', '-z', from, resolvedHead, '--'],
    { cwd, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}
