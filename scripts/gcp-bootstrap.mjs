import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applications,
  readEnvironment,
  serviceAccount,
  profileObjectExpression,
  assertProfileGrantIsolation,
} from './gke-lib.mjs';
const config = readEnvironment(process.env.GCP_ENV_FILE);
const execute = process.argv.includes('--apply');
const project = config.project;
const bucket = `${project}-${config.namespace}-media`;
const profileExpression = profileObjectExpression(bucket);
function run(args, { read = false } = {}) {
  if (!execute) {
    console.log(JSON.stringify(['gcloud', ...args, '--project', project]));
    return '';
  }
  const result = spawnSync(
    'gcloud',
    [...args, '--project', project, '--quiet'],
    { encoding: 'utf8', stdio: read ? ['ignore', 'pipe', 'pipe'] : 'inherit' },
  );
  if (result.status !== 0)
    throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed`);
  return result.stdout?.trim() ?? '';
}
// List errors are fatal; a permission/network failure must not look like an absent resource.
function ensure(listArgs, name, createArgs) {
  const existing = execute
    ? JSON.parse(run([...listArgs, '--format=json(name)'], { read: true }))
    : [];
  if (
    !existing.some(
      (item) => item.name === name || item.name.endsWith(`/${name}`),
    )
  ) {
    run(createArgs);
    return true;
  }
  return false;
}

// Check known additive grants before any --apply mutation. Never revoke existing
// access automatically, and never treat a read/role lookup failure as safe.
if (execute) {
  const policies = [
    JSON.parse(
      run(['projects', 'get-iam-policy', project, '--format=json'], {
        read: true,
      }),
    ),
  ];
  const buckets = JSON.parse(
    run(['storage', 'buckets', 'list', '--format=json(name)'], { read: true }),
  );
  if (buckets.some((b) => b.name === bucket || b.name === `gs://${bucket}`))
    policies.push(
      JSON.parse(
        run(
          [
            'storage',
            'buckets',
            'get-iam-policy',
            `gs://${bucket}`,
            '--format=json',
          ],
          { read: true },
        ),
      ),
    );
  const member = `serviceAccount:${serviceAccount(config, 'user-service')}`;
  const roles = {};
  for (const policy of policies)
    for (const binding of policy.bindings ?? []) {
      if (
        !(binding.members ?? []).some((m) =>
          [member, 'allUsers', 'allAuthenticatedUsers'].includes(m),
        )
      )
        continue;
      if (roles[binding.role]) continue;
      const custom = /^projects\/([^/]+)\/roles\/([^/]+)$/.exec(binding.role);
      if (custom && custom[1] !== project)
        throw new Error(
          'Cross-project profile IAM role requires operator review',
        );
      const args = [
        'iam',
        'roles',
        'describe',
        custom ? custom[2] : binding.role,
        '--format=json',
      ];
      roles[binding.role] = JSON.parse(
        run(args, { read: true }),
      ).includedPermissions;
    }
  assertProfileGrantIsolation(policies, member, profileExpression, roles);
}
run([
  'services',
  'enable',
  'container.googleapis.com',
  'compute.googleapis.com',
  'artifactregistry.googleapis.com',
  'sqladmin.googleapis.com',
  'secretmanager.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'servicenetworking.googleapis.com',
  'gkebackup.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'firebasecloudmessaging.googleapis.com',
]);
const projectNumber = execute
  ? run(['projects', 'describe', project, '--format=value(projectNumber)'], {
      read: true,
    })
  : 'PROJECT_NUMBER';
const network = config.cluster;
ensure(['compute', 'networks', 'list'], network, [
  'compute',
  'networks',
  'create',
  network,
  '--subnet-mode=custom',
]);
ensure(
  ['compute', 'networks', 'subnets', 'list', `--regions=${config.region}`],
  network,
  [
    'compute',
    'networks',
    'subnets',
    'create',
    network,
    `--network=${network}`,
    `--region=${config.region}`,
    '--range=10.40.0.0/20',
    '--secondary-range=pods=10.44.0.0/14,services=10.48.0.0/20',
    '--enable-private-ip-google-access',
  ],
);
ensure(['compute', 'routers', 'list', `--regions=${config.region}`], network, [
  'compute',
  'routers',
  'create',
  network,
  `--network=${network}`,
  `--region=${config.region}`,
]);
ensure(
  [
    'compute',
    'routers',
    'nats',
    'list',
    `--router=${network}`,
    `--region=${config.region}`,
  ],
  'egress',
  [
    'compute',
    'routers',
    'nats',
    'create',
    'egress',
    `--router=${network}`,
    `--region=${config.region}`,
    '--nat-all-subnet-ip-ranges',
    '--auto-allocate-nat-external-ips',
  ],
);
ensure(['compute', 'addresses', 'list', '--global'], `${network}-sql`, [
  'compute',
  'addresses',
  'create',
  `${network}-sql`,
  '--global',
  '--purpose=VPC_PEERING',
  '--prefix-length=16',
  `--network=${network}`,
]);
const peers = execute
  ? JSON.parse(
      run(
        [
          'services',
          'vpc-peerings',
          'list',
          `--network=${network}`,
          '--service=servicenetworking.googleapis.com',
          '--format=json',
        ],
        { read: true },
      ),
    )
  : [];
if (!peers.length)
  run([
    'services',
    'vpc-peerings',
    'connect',
    '--service=servicenetworking.googleapis.com',
    `--network=${network}`,
    `--ranges=${network}-sql`,
  ]);
const nodeAccount = `${config.namespace}-nodes`;
ensure(
  ['iam', 'service-accounts', 'list'],
  `${nodeAccount}@${project}.iam.gserviceaccount.com`,
  ['iam', 'service-accounts', 'create', nodeAccount],
);
for (const role of [
  'roles/container.defaultNodeServiceAccount',
  'roles/artifactregistry.reader',
])
  run([
    'projects',
    'add-iam-policy-binding',
    project,
    `--member=serviceAccount:${nodeAccount}@${project}.iam.gserviceaccount.com`,
    `--role=${role}`,
    '--condition=None',
  ]);
ensure(
  ['container', 'clusters', 'list', `--region=${config.region}`],
  config.cluster,
  [
    'container',
    'clusters',
    'create-auto',
    config.cluster,
    `--region=${config.region}`,
    `--network=${network}`,
    `--subnetwork=${network}`,
    '--cluster-secondary-range-name=pods',
    '--services-secondary-range-name=services',
    '--enable-private-nodes',
    '--enable-dns-access',
    '--no-enable-ip-access',
    '--enable-secret-manager',
    '--enable-backup-restore',
    `--service-account=${nodeAccount}@${project}.iam.gserviceaccount.com`,
    '--release-channel=regular',
    '--logging=SYSTEM,WORKLOAD',
    '--monitoring=SYSTEM',
  ],
);
ensure(
  ['artifacts', 'repositories', 'list', `--location=${config.region}`],
  'wgo',
  [
    'artifacts',
    'repositories',
    'create',
    'wgo',
    `--location=${config.region}`,
    '--repository-format=docker',
  ],
);
ensure(['compute', 'addresses', 'list', '--global'], config.staticIp, [
  'compute',
  'addresses',
  'create',
  config.staticIp,
  '--global',
]);
const instance = config.sqlInstance.split(':')[2];
ensure(['sql', 'instances', 'list'], instance, [
  'sql',
  'instances',
  'create',
  instance,
  '--database-version=POSTGRES_17',
  '--edition=ENTERPRISE',
  '--tier=db-custom-1-3840',
  `--region=${config.region}`,
  `--network=projects/${project}/global/networks/${network}`,
  '--no-assign-ip',
  '--database-flags=cloudsql.iam_authentication=on',
  '--enable-point-in-time-recovery',
  '--backup-start-time=18:00',
  '--retained-backups-count=7',
  '--retained-transaction-log-days=7',
  '--deletion-protection',
  '--storage-size=20',
]);
for (const [name] of applications) {
  const account = serviceAccount(config, name);
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
    `--member=serviceAccount:${project}.svc.id.goog[${config.namespace}/${name}]`,
    '--role=roles/iam.workloadIdentityUser',
  ]);
  const secret = `${config.namespace}-${name}-runtime`;
  ensure(['secrets', 'list'], secret, [
    'secrets',
    'create',
    secret,
    '--replication-policy=user-managed',
    `--locations=${config.region}`,
  ]);
  run([
    'secrets',
    'add-iam-policy-binding',
    secret,
    `--member=serviceAccount:${account}`,
    '--role=roles/secretmanager.secretAccessor',
  ]);
  run([
    'secrets',
    'add-iam-policy-binding',
    secret,
    `--member=principal://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${project}.svc.id.goog/subject/ns/${config.namespace}/sa/${name}`,
    '--role=roles/secretmanager.secretAccessor',
  ]);
  if (['user-service', 'notification-service'].includes(name)) {
    for (const role of ['roles/cloudsql.client', 'roles/cloudsql.instanceUser'])
      run([
        'projects',
        'add-iam-policy-binding',
        project,
        `--member=serviceAccount:${account}`,
        `--role=${role}`,
        '--condition=None',
      ]);
    const user = account.replace('.gserviceaccount.com', '');
    ensure(['sql', 'users', 'list', `--instance=${instance}`], user, [
      'sql',
      'users',
      'create',
      account,
      `--instance=${instance}`,
      '--type=CLOUD_IAM_SERVICE_ACCOUNT',
    ]);
    const database = name === 'user-service' ? 'wgo_user' : 'wgo_notification';
    ensure(['sql', 'databases', 'list', `--instance=${instance}`], database, [
      'sql',
      'databases',
      'create',
      database,
      `--instance=${instance}`,
    ]);
  }
}
const mediaCreated = ensure(['storage', 'buckets', 'list'], bucket, [
  'storage',
  'buckets',
  'create',
  `gs://${bucket}`,
  `--location=${config.region}`,
  '--uniform-bucket-level-access',
  '--public-access-prevention',
]);
// User object access is restricted to its prefix in the shared bucket. Signing grants signBlob alone,
// rather than the broader token-minting permissions of TokenCreator.
for (const [id, permissions] of [
  [
    'wgoProfileObjects',
    'storage.objects.create,storage.objects.get,storage.objects.delete',
  ],
  ['wgoProfileSigner', 'iam.serviceAccounts.signBlob'],
]) {
  const created = ensure(
    ['iam', 'roles', 'list'],
    `projects/${project}/roles/${id}`,
    [
      'iam',
      'roles',
      'create',
      id,
      `--permissions=${permissions}`,
      '--stage=GA',
    ],
  );
  if (execute && !created) {
    const role = JSON.parse(
      run(['iam', 'roles', 'describe', id, '--format=json'], { read: true }),
    );
    if (
      JSON.stringify([...(role.includedPermissions ?? [])].sort()) !==
      JSON.stringify(permissions.split(',').sort())
    )
      throw new Error(
        'Existing profile IAM role differs; operator review required',
      );
  }
}
run([
  'storage',
  'buckets',
  'add-iam-policy-binding',
  `gs://${bucket}`,
  `--member=serviceAccount:${serviceAccount(config, 'user-service')}`,
  `--role=projects/${project}/roles/wgoProfileObjects`,
  `--condition=expression=${profileExpression},title=wgo_profile_prefix`,
]);
run([
  'iam',
  'service-accounts',
  'add-iam-policy-binding',
  serviceAccount(config, 'user-service'),
  `--member=serviceAccount:${serviceAccount(config, 'user-service')}`,
  `--role=projects/${project}/roles/wgoProfileSigner`,
]);
if (mediaCreated)
  run(['storage', 'buckets', 'update', `gs://${bucket}`, '--versioning']);
run([
  'storage',
  'buckets',
  'add-iam-policy-binding',
  `gs://${bucket}`,
  `--member=serviceAccount:${serviceAccount(config, 'post-service')}`,
  '--role=roles/storage.objectAdmin',
]);
run([
  'iam',
  'service-accounts',
  'add-iam-policy-binding',
  serviceAccount(config, 'post-service'),
  `--member=serviceAccount:${serviceAccount(config, 'post-service')}`,
  '--role=roles/iam.serviceAccountTokenCreator',
]);
run([
  'projects',
  'add-iam-policy-binding',
  project,
  `--member=serviceAccount:${serviceAccount(config, 'notification-service')}`,
  '--role=roles/firebasecloudmessaging.admin',
  '--condition=None',
]);
// Existing shared buckets may contain Post-specific CORS/lifecycle/versioning.
// Do not replace them; operators review any missing additive rules separately.
if (mediaCreated) {
  const corsDirectory = mkdtempSync(join(tmpdir(), 'wgo-gcs-cors-'));
  try {
    const path = join(corsDirectory, 'cors.json');
    writeFileSync(
      path,
      JSON.stringify([
        {
          origin: config.webOrigins,
          method: ['GET', 'HEAD', 'PUT'],
          responseHeader: [
            'Content-Type',
            'Content-Length',
            'ETag',
            'x-goog-generation',
            'x-goog-if-generation-match',
          ],
          maxAgeSeconds: 3600,
        },
      ]),
    );
    run([
      'storage',
      'buckets',
      'update',
      `gs://${bucket}`,
      `--cors-file=${path}`,
    ]);
    const lifecyclePath = join(corsDirectory, 'profile-lifecycle.json');
    writeFileSync(
      lifecyclePath,
      JSON.stringify({
        rule: [
          {
            action: { type: 'Delete' },
            condition: { age: 1, matchesPrefix: ['user-profiles/pending/'] },
          },
        ],
      }),
    );
    // Backstop for late PUTs. Final objects are reconciled against PostgreSQL references.
    run([
      'storage',
      'buckets',
      'update',
      `gs://${bucket}`,
      `--lifecycle-file=${lifecyclePath}`,
    ]);
  } finally {
    rmSync(corsDirectory, { recursive: true });
  }
}
const snapshotAccount = `${config.namespace}-es-snapshots@${project}.iam.gserviceaccount.com`;
ensure(['iam', 'service-accounts', 'list'], snapshotAccount, [
  'iam',
  'service-accounts',
  'create',
  snapshotAccount.split('@')[0],
]);
run([
  'iam',
  'service-accounts',
  'add-iam-policy-binding',
  snapshotAccount,
  `--member=serviceAccount:${project}.svc.id.goog[${config.namespace}/elasticsearch-snapshot]`,
  '--role=roles/iam.workloadIdentityUser',
]);
const snapshotBucket = `${project}-${config.namespace}-es-snapshots`;
ensure(['storage', 'buckets', 'list'], snapshotBucket, [
  'storage',
  'buckets',
  'create',
  `gs://${snapshotBucket}`,
  `--location=${config.region}`,
  '--uniform-bucket-level-access',
  '--public-access-prevention',
]);
run([
  'storage',
  'buckets',
  'add-iam-policy-binding',
  `gs://${snapshotBucket}`,
  `--member=serviceAccount:${snapshotAccount}`,
  '--role=roles/storage.objectAdmin',
]);
console.log(
  execute
    ? 'Infrastructure resources prepared. SQL grants, secret values, storage bootstrap and GitHub OIDC binding remain explicit operator steps in gcp.md.'
    : 'Dry run only. Pass --apply only with authorization for billable resource creation.',
);
