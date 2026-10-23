import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function successfulBase(runs, { branch, head, isAncestor }) {
  for (const run of runs) {
    if (
      run.event !== 'push' ||
      run.conclusion !== 'success' ||
      run.head_branch !== branch ||
      !/^[a-f0-9]{40,64}$/.test(run.head_sha ?? '')
    )
      continue;
    if (isAncestor(run.head_sha, head)) return run.head_sha;
  }
  return '';
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let base = '';
  try {
    const branch = process.env.GITHUB_REF_NAME;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!branch || !repository) throw new Error('GitHub context is required');
    const response = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          'GET',
          `repos/${repository}/actions/workflows/ci.yml/runs`,
          '-f',
          `branch=${branch}`,
          '-f',
          'event=push',
          '-f',
          'status=success',
          '-f',
          'per_page=100',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    base = successfulBase(response.workflow_runs ?? [], {
      branch,
      head: 'HEAD',
      isAncestor: (from, to) =>
        spawnSync('git', ['merge-base', '--is-ancestor', from, to], {
          stdio: 'ignore',
        }).status === 0,
    });
  } catch {
    // A missing API/history baseline must not let a previously failed commit escape validation.
    console.warn(
      'Successful CI baseline unavailable; running full validation.',
    );
  }
  const output = `base=${base}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
