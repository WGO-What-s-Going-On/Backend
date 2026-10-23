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
  post: ['mongo', 'redis6380'],
  map: ['cassandra', 'redis6381'],
  notification: ['redis6382', 'dynamodb'],
  moderation: ['redis6383'],
}[service.dependencies];
const project = `wgo-ci-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${name}`;
const compose = ['compose', '-f', 'scripts/ci-compose.yaml', '-p', project];
function docker(args, input) {
  const result = spawnSync('docker', [...compose, ...args], {
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`CI dependency command failed (${result.status})`);
}
if (command === 'stop') docker(['down', '--volumes', '--remove-orphans']);
else {
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
  if (service.dependencies === 'map')
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
