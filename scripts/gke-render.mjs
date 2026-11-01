import {
  readEnvironment,
  foundation,
  applications,
  appResources,
} from './gke-lib.mjs';
import { storageResources } from './gke-storage.mjs';
const config = readEnvironment(process.env.GCP_ENV_FILE);
const mode = process.argv[2];
let items;
if (mode === 'foundation') items = foundation(config);
else if (mode === 'storage') items = storageResources(config);
else if (mode === 'apps') {
  if (!/^[a-f0-9]{64}$/.test(process.env.IMAGE_DIGEST ?? ''))
    throw new Error(
      'Set IMAGE_DIGEST to render an inspection fixture; real CD uses per-service digests',
    );
  items = applications.flatMap(([name]) =>
    appResources(
      config,
      name,
      `${config.registry}/${name}@sha256:${process.env.IMAGE_DIGEST}`,
    ),
  );
} else throw new Error('Usage: gke-render.mjs foundation|storage|apps');
console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
