import { readEnvironment, serviceAccount } from './gke-lib.mjs';
const config = readEnvironment(process.env.GCP_ENV_FILE);
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
for (const [service, database] of [
  ['user-service', 'wgo_user'],
  ['notification-service', 'wgo_notification'],
]) {
  const role = quote(
    serviceAccount(config, service).replace('.gserviceaccount.com', ''),
  );
  console.log(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC;`);
  console.log(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${role};`);
  console.log(`\\connect ${database}`);
  console.log('REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
  console.log(`GRANT USAGE, CREATE ON SCHEMA public TO ${role};`);
}
