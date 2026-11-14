import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  appResources,
  profileObjectExpression,
  assertProfileGrantIsolation,
} from './gke-lib.mjs';
const config = JSON.parse(readFileSync('deploy/gke/environment.example.json'));
const bucket = `${config.project}-${config.namespace}-media`;
const user = `serviceAccount:${config.namespace}-user@${config.project}.iam.gserviceaccount.com`;
const objects = [
  'storage.objects.create',
  'storage.objects.get',
  'storage.objects.delete',
];

// All gcloud calls are intercepted, even for --apply branches: no network,
// credentials or cloud mutation is involved, on Windows or Linux.
function bootstrap({
  existing = false,
  broad = false,
  failRead = false,
  drift = false,
} = {}) {
  const code = `
 import cp from 'node:child_process';
 import {syncBuiltinESMExports} from 'node:module';
 import {readFileSync} from 'node:fs';
 const commands=[],files=[];
 cp.spawnSync=(cmd,args)=>{
  if(cmd!=='gcloud') throw new Error('Unexpected command');
  commands.push(args);
  for(const arg of args) if(arg.startsWith('--cors-file=') || arg.startsWith('--lifecycle-file='))
   files.push({flag:arg.split('=')[0],value:JSON.parse(readFileSync(arg.slice(arg.indexOf('=')+1),'utf8'))});
  if(${failRead} && args[0]==='projects' && args[1]==='get-iam-policy') return {status:1};
  let out='';
  if(args.includes('get-iam-policy')) out=JSON.stringify({bindings:${broad}?[{role:'roles/storage.objectAdmin',members:[${JSON.stringify(user)}]}]:[]});
  else if(args[0]==='projects' && args[1]==='describe') out='12345';
  else if(args.includes('list')) out=JSON.stringify(args[0]==='storage' && ${existing}?[{name:${JSON.stringify(bucket)}}]:args[0]==='iam' && args[1]==='roles' && ${drift}?[{name:'projects/${config.project}/roles/wgoProfileObjects'}]:[]);
  else if(args[0]==='iam' && args[1]==='roles' && args[2]==='describe') out=JSON.stringify({includedPermissions:['storage.objects.list']});
  return {status:0,stdout:out};
 };
 syncBuiltinESMExports();
 process.argv.push('--apply');
 try {await import(${JSON.stringify(new URL('./gcp-bootstrap.mjs', import.meta.url).href)});}
 catch(e){console.error(e.message);process.exitCode=1;}
 console.log('MOCK_TRACE='+JSON.stringify(commands));
 console.log('MOCK_FILES='+JSON.stringify(files));`;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', code],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GCP_ENV_FILE: 'deploy/gke/environment.example.json',
      },
    },
  );
  const trace = r.stdout.split('\n').find((l) => l.startsWith('MOCK_TRACE='));
  const files = r.stdout.split('\n').find((l) => l.startsWith('MOCK_FILES='));
  return {
    ...r,
    commands: trace ? JSON.parse(trace.slice(11)) : [],
    files: files ? JSON.parse(files.slice(11)) : [],
  };
}

test('shared bucket grants only profile object operations and self signBlob', () => {
  const r = bootstrap();
  assert.equal(r.status, 0, r.stderr);
  assert(
    !r.commands.some((c) =>
      c.some(
        (p) => String(p).startsWith('gs://') && String(p).endsWith('-profiles'),
      ),
    ),
  );
  const grants = r.commands.filter(
    (c) =>
      c.includes('add-iam-policy-binding') && c.includes(`--member=${user}`),
  );
  const grant = grants.find((c) =>
    c.includes(`--role=projects/${config.project}/roles/wgoProfileObjects`),
  );
  assert(grant.includes(`gs://${bucket}`));
  assert(
    grant.includes(
      `--condition=expression=${profileObjectExpression(bucket)},title=wgo_profile_prefix`,
    ),
  );
  assert(
    r.commands.some((c) => c.includes('--permissions=' + objects.join(','))),
  );
  const signer = grants.find((c) =>
    c.includes(`--role=projects/${config.project}/roles/wgoProfileSigner`),
  );
  assert.equal(signer[3], user.slice('serviceAccount:'.length));
  assert(
    r.commands.some((c) =>
      c.includes('--permissions=iam.serviceAccounts.signBlob'),
    ),
  );
  assert(
    !grants.some((c) =>
      c.includes('--role=roles/iam.serviceAccountTokenCreator'),
    ),
  );
  assert(!r.commands.some((c) => c.includes('keys') && c.includes('create')));
  assert(
    r.commands.some(
      (c) =>
        c.includes(`gs://${bucket}`) &&
        c.includes('--role=roles/storage.objectAdmin'),
    ),
  );
});
test('existing shared bucket CORS, lifecycle and versioning are not overwritten', () => {
  const r = bootstrap({ existing: true });
  assert.equal(r.status, 0, r.stderr);
  assert(
    !r.commands.some(
      (c) =>
        c[0] === 'storage' &&
        c[1] === 'buckets' &&
        ['update', 'create'].includes(c[2]) &&
        c.includes(`gs://${bucket}`),
    ),
  );
});
test('existing broad User IAM stops before mutations', () => {
  const r = bootstrap({ existing: true, broad: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Existing broad User storage grant/);
  assert(
    !r.commands.some(
      (c) =>
        c.includes('add-iam-policy-binding') ||
        c.includes('create') ||
        c.includes('enable'),
    ),
  );
});
test('IAM read failure fails closed before mutations', () => {
  const r = bootstrap({ failRead: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.commands.length, 1);
});
test('existing custom role drift is not overwritten or bound', () => {
  const r = bootstrap({ existing: true, drift: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Existing profile IAM role differs/);
  assert(
    !r.commands.some((c) =>
      c.includes(`--role=projects/${config.project}/roles/wgoProfileObjects`),
    ),
  );
});
test('project and public broad grants are not restricted by adding a condition', () => {
  const expr = profileObjectExpression(bucket);
  const scoped = {
    role: 'profile',
    members: [user],
    condition: { expression: expr },
  };
  assert.doesNotThrow(() =>
    assertProfileGrantIsolation([{ bindings: [scoped] }], user, expr, {
      profile: objects,
    }),
  );
  for (const member of [user, 'allUsers', 'allAuthenticatedUsers'])
    assert.throws(
      () =>
        assertProfileGrantIsolation(
          [
            { bindings: [{ role: 'wide', members: [member] }] },
            { bindings: [scoped] },
          ],
          user,
          expr,
          { wide: ['storage.objects.*'], profile: objects },
        ),
      /broad User storage grant/,
    );
  assert.throws(
    () => assertProfileGrantIsolation([{ bindings: [scoped] }], user, expr, {}),
    /permissions unavailable/,
  );
  assert.throws(
    () =>
      assertProfileGrantIsolation([{ bindings: [scoped] }], user, expr, {
        profile: [...objects, 'storage.objects.list'],
      }),
    /broad User storage grant/,
  );
});
test('fresh shared buckets receive one CORS and profile pending lifecycle configuration', () => {
  const r = bootstrap();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.commands.filter((c) => c.some((p) => p.startsWith('--cors-file=')))
      .length,
    1,
  );
  assert.equal(
    r.commands.filter((c) => c.some((p) => p.startsWith('--lifecycle-file=')))
      .length,
    1,
  );
  assert.deepEqual(r.files.find((f) => f.flag === '--lifecycle-file').value, {
    rule: [
      {
        action: { type: 'Delete' },
        condition: { age: 1, matchesPrefix: ['user-profiles/pending/'] },
      },
    ],
  });
  const cors = r.files.find((f) => f.flag === '--cors-file').value;
  assert.deepEqual(cors[0].origin, config.webOrigins);
  assert.deepEqual(cors[0].method, ['GET', 'HEAD', 'PUT']);
});
test('User deployment uses the shared media bucket, including the actual project', () => {
  for (const c of [
    config,
    {
      ...config,
      project: 'project-103a7af1-0f7c-4697-972',
      registry:
        'asia-northeast3-docker.pkg.dev/project-103a7af1-0f7c-4697-972/wgo',
      sqlInstance: 'project-103a7af1-0f7c-4697-972:asia-northeast3:wgo-demo',
    },
  ]) {
    const resources = appResources(
      c,
      'user-service',
      `${c.registry}/user-service@sha256:${'a'.repeat(64)}`,
    );
    const settings = resources.find((i) => i.kind === 'ConfigMap').data;
    assert.equal(settings.GCS_PROFILE_ENABLED, 'true');
    assert.equal(
      settings.GCS_PROFILE_BUCKET,
      `${c.project}-${c.namespace}-media`,
    );
    assert.equal(settings.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  }
});
