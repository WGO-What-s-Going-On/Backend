import { spawnSync } from 'node:child_process';
import { readEnvironment } from './gke-lib.mjs';
const config = readEnvironment(process.env.GCP_ENV_FILE);
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
  throw new Error('GITHUB_REPOSITORY owner/name required');
const apply = process.argv.includes('--apply');
function run(args, read = false) {
  if (!apply) {
    console.log(
      JSON.stringify(['gcloud', ...args, '--project', config.project]),
    );
    return '';
  }
  const result = spawnSync(
    'gcloud',
    [...args, '--project', config.project, '--quiet'],
    { encoding: 'utf8', stdio: read ? ['ignore', 'pipe', 'pipe'] : 'inherit' },
  );
  if (result.status !== 0)
    throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed`);
  return result.stdout?.trim() ?? '';
}
function ensure(args, name, create) {
  const entries = apply
    ? JSON.parse(run([...args, '--format=json(name)'], true))
    : [];
  if (!entries.some((e) => e.name === name || e.name.endsWith('/' + name)))
    run(create);
}
const pool = `${config.namespace}-github`;
const account = `${config.namespace}-deploy@${config.project}.iam.gserviceaccount.com`;
const number = apply
  ? run(
      ['projects', 'describe', config.project, '--format=value(projectNumber)'],
      true,
    )
  : 'PROJECT_NUMBER';
ensure(['iam', 'workload-identity-pools', 'list', '--location=global'], pool, [
  'iam',
  'workload-identity-pools',
  'create',
  pool,
  '--location=global',
]);
ensure(
  [
    'iam',
    'workload-identity-pools',
    'providers',
    'list',
    '--location=global',
    `--workload-identity-pool=${pool}`,
  ],
  'github',
  [
    'iam',
    'workload-identity-pools',
    'providers',
    'create-oidc',
    'github',
    '--location=global',
    `--workload-identity-pool=${pool}`,
    '--issuer-uri=https://token.actions.githubusercontent.com',
    '--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref',
    `--attribute-condition=assertion.repository == '${repository}' && assertion.ref == 'refs/heads/main'`,
  ],
);
ensure(['iam', 'service-accounts', 'list'], account, [
  'iam',
  'service-accounts',
  'create',
  account.split('@')[0],
]);
run([
  'iam',
  'service-accounts',
  'add-iam-policy-binding',
  account,
  `--member=principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.repository/${repository}`,
  '--role=roles/iam.workloadIdentityUser',
]);
run([
  'artifacts',
  'repositories',
  'add-iam-policy-binding',
  'wgo',
  `--location=${config.region}`,
  `--member=serviceAccount:${account}`,
  '--role=roles/artifactregistry.writer',
]);
run([
  'projects',
  'add-iam-policy-binding',
  config.project,
  `--member=serviceAccount:${account}`,
  '--role=roles/container.clusterViewer',
  '--condition=None',
]);
const resources = [
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'wgo-deployer', namespace: config.namespace },
    rules: [
      {
        apiGroups: [''],
        resources: ['configmaps', 'services', 'serviceaccounts'],
        verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
      },
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'deployments/scale', 'replicasets'],
        verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
      },
      {
        apiGroups: ['batch'],
        resources: ['jobs', 'cronjobs'],
        verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
      },
      {
        apiGroups: ['secrets-store.csi.x-k8s.io'],
        resources: ['secretproviderclasses'],
        verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
      },
    ],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'wgo-deployer', namespace: config.namespace },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: 'wgo-deployer',
    },
    subjects: [
      { kind: 'User', apiGroup: 'rbac.authorization.k8s.io', name: account },
    ],
  },
];
if (apply) {
  const context = spawnSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf8',
  });
  if (
    context.status !== 0 ||
    context.stdout.trim() !==
      `gke_${config.project}_${config.region}_${config.cluster}`
  )
    throw new Error('Select the configured GKE context before RBAC binding');
  const result = spawnSync('kubectl', ['apply', '-f', '-'], {
    input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error('RBAC binding failed');
} else
  console.log(
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }),
  );
console.log(
  JSON.stringify({
    GCP_DEPLOY_SERVICE_ACCOUNT: account,
    GCP_WORKLOAD_IDENTITY_PROVIDER: `projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/github`,
  }),
);
