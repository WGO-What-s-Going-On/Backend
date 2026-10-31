import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { services } from './ci-lib.mjs';

const [command, name] = process.argv.slice(2);
const service = services.find((entry) => entry.name === name);
if (!service || !['start', 'stop'].includes(command))
  throw new Error('Usage: ci-dependencies.mjs start|stop <service>');
const dependencies = {
  http: ['redis6381'],
  ws: ['redis6380'],
  user: ['postgres', 'redis6379'],
  post: ['mongo', 'redis6380', 'cassandra', 'elasticsearch'],
  map: ['cassandra', 'redis6381'],
  notification: ['redis6382', 'dynamodb'],
  moderation: ['postgres', 'redis6383'],
}[service.dependencies];
const project = `wgo-ci-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${name}`;
const compose = ['compose', '-f', 'scripts/ci-compose.yaml', '-p', project];
function docker(args, input) {
  const result = spawnSync('docker', [...compose, ...args], {
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`CI dependency command failed (${result.status})`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}
async function start() {
  docker(['up', '-d', '--wait', '--wait-timeout', '360', ...dependencies]);
  if (service.dependencies === 'post') {
    docker([
      'exec',
      '-T',
      'mongo',
      'mongosh',
      '--quiet',
      '--eval',
      "try { rs.status(); } catch (error) { if (error.codeName !== 'NotYetInitialized') throw error; rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}); } for (let i=0; i<60; i++) { if (db.hello().isWritablePrimary) quit(0); sleep(1000); } quit(1);",
    ]);
  }
  if (dependencies.includes('cassandra'))
    docker(
      ['exec', '-T', 'cassandra', 'cqlsh'],
      readFileSync('services/map-service/schema.cql'),
    );
  if (service.dependencies === 'notification') {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await fetch('http://127.0.0.1:8002', {
          signal: AbortSignal.timeout(1000),
        });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!ready) throw new Error('DynamoDB Local did not start');
  }
}

// 진단 실패나 Docker daemon 응답 지연이 원래 오류와 후속 정리 작업을 가리지 않게 한다.
function diagnostic(label, executable, args) {
  console.log(`::group::CI dependency diagnostics: ${label}`);
  try {
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.error || result.status !== 0)
      console.error(
        `Diagnostic unavailable: ${label} (${result.error?.code ?? result.status})`,
      );
    return result.stdout ?? '';
  } catch (error) {
    console.error(
      `Diagnostic unavailable: ${label} (${error.code ?? 'unknown'})`,
    );
    return '';
  } finally {
    console.log('::endgroup::');
  }
}

function collectDiagnostics() {
  diagnostic('runner kernel', 'uname', ['-a']);
  diagnostic('Docker host kernel', 'docker', [
    'info',
    '--format',
    '{{.KernelVersion}}',
  ]);
  diagnostic('container status', 'docker', [
    ...compose,
    'ps',
    '-a',
    ...dependencies,
  ]);
  diagnostic('container logs (last 300 lines per service)', 'docker', [
    ...compose,
    'logs',
    '--no-color',
    '--timestamps',
    '--tail',
    '300',
    ...dependencies,
  ]);
  const ids = diagnostic('container IDs', 'docker', [
    ...compose,
    'ps',
    '-a',
    '-q',
    ...dependencies,
  ])
    .split(/\s+/)
    .filter((id) => /^[a-f0-9]{12,64}$/.test(id));
  if (ids.length) {
    // 전체 inspect에는 환경변수가 포함된다. 종료·OOM·healthcheck 상태와 이미지 ID만 출력한다.
    diagnostic('exit / OOM / health state', 'docker', [
      'inspect',
      '--format',
      '{{.Name}} image={{.Image}} state={{json .State}}',
      ...ids,
    ]);
  }
  diagnostic('runner memory', 'free', ['-h']);
  diagnostic('runner disk', 'df', ['-h']);
}

if (command === 'stop') docker(['down', '--volumes', '--remove-orphans']);
else {
  try {
    await start();
  } catch (error) {
    console.error(error);
    collectDiagnostics();
    process.exitCode = error.exitCode ?? 1;
  }
}
