import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageResources } from './gke-storage.mjs';
import { readFileSync } from 'node:fs';
const config = {
  project: 'wgo-test',
  namespace: 'wgo-demo',
  region: 'asia-northeast3',
  cluster: 'wgo-demo',
};

test('stateful stores retain disks, require TLS and expose no public endpoints', () => {
  const manifests = storageResources(config);
  const stores = manifests.filter((m) => m.kind === 'StatefulSet');
  assert.deepEqual(
    stores.map((m) => m.metadata.name),
    ['mongodb', 'redis', 'cassandra'],
  );
  for (const store of stores) {
    assert.equal(store.spec.replicas, 1);
    assert.deepEqual(store.spec.persistentVolumeClaimRetentionPolicy, {
      whenDeleted: 'Retain',
      whenScaled: 'Retain',
    });
    assert.equal(
      store.spec.volumeClaimTemplates[0].spec.storageClassName,
      'premium-rwo',
    );
    const pod = store.spec.template.spec;
    assert.equal(pod.containers[0].securityContext.runAsNonRoot, true);
    assert.ok(
      pod.volumes.some(
        (v) => v.secret?.secretName === `${store.metadata.name}-server-tls`,
      ),
    );
    assert.equal(pod.containers[0].securityContext.privileged, undefined);
  }
  for (const service of manifests.filter((m) => m.kind === 'Service'))
    assert.equal(service.spec.clusterIP, 'None');
  const mongo = stores[0].spec.template.spec;
  assert.ok(mongo.initContainers[0].command.at(-1).includes('chmod 400'));
  const cassandra = stores[2].spec.template.spec.containers[0];
  assert.ok(
    cassandra.readinessProbe.exec.command
      .at(-1)
      .includes('wgo_map.post_status'),
  );
});
test('ECK uses persistent single-node mmap-free Autopilot configuration', () => {
  const es = storageResources(config).find((m) => m.kind === 'Elasticsearch');
  assert.equal(es.spec.version, '8.19.4');
  assert.equal(es.spec.volumeClaimDeletePolicy, 'DeleteOnScaledownOnly');
  assert.equal(es.spec.nodeSets[0].config['node.store.allow_mmap'], false);
  assert.equal(
    es.spec.nodeSets[0].volumeClaimTemplates[0].spec.storageClassName,
    'premium-rwo',
  );
});
test('bootstrap preserves application ownership and durable Redis semantics', () => {
  const configMap = storageResources(config).find(
    (m) => m.kind === 'ConfigMap',
  );
  assert.match(
    configMap.data['mongo-init.js'],
    /role: 'readWrite', db: 'wgo_post'/,
  );
  assert.match(configMap.data['mongo-init.js'], /rs.initiate/);
  assert.match(
    configMap.data['cassandra-start.sh'],
    /GRANT MODIFY ON KEYSPACE wgo_map TO wgo_map/,
  );
  assert.match(configMap.data['schema.cql'], /NetworkTopologyStrategy/);
  assert.match(configMap.data['redis-start.sh'], /appendfsync always/);
  assert.match(configMap.data['redis-start.sh'], /maxmemory-policy noeviction/);
  assert.match(configMap.data['redis-start.sh'], /port 0/);
});
test('provisioning refuses credential overwrite and restore refuses source cluster', () => {
  const secrets = readFileSync(
    new URL('./gcp-storage-secrets.sh', import.meta.url),
    'utf8',
  );
  assert.match(secrets, /Storage credentials already exist/);
  const backup = readFileSync(
    new URL('./gcp-storage-backup.sh', import.meta.url),
    'utf8',
  );
  assert.match(backup, /--include-volume-data --include-secrets/);
  assert.match(backup, /--namespaced-resource-restore-mode=fail-on-conflict/);
  assert.match(backup, /"\$target" != "\$cluster"/);
  assert.throws(() => storageResources({ ...config, region: 'us-central1' }));
});
test('filesystem backups exclude ECK and GCS snapshots use Workload Identity', () => {
  const manifests = storageResources(config);
  const app = manifests.find((m) => m.kind === 'ProtectedApplication');
  assert.deepEqual(
    app.spec.components.map((c) => c.name),
    ['mongodb', 'redis', 'cassandra'],
  );
  for (const stateful of manifests.filter((m) => m.kind === 'StatefulSet')) {
    assert.equal(stateful.metadata.labels['wgo/backup'], 'databases');
    assert.equal(
      stateful.spec.template.metadata.labels['wgo/backup'],
      'databases',
    );
    assert.equal(
      stateful.spec.volumeClaimTemplates[0].metadata.labels['wgo/backup'],
      'databases',
    );
  }
  const es = manifests.find((m) => m.kind === 'Elasticsearch');
  assert.equal(es.metadata.labels?.['wgo/backup'], undefined);
  assert.equal(
    es.spec.nodeSets[0].podTemplate.spec.serviceAccountName,
    'elasticsearch-snapshot',
  );
  const job = manifests.find(
    (m) => m.metadata.name === 'elasticsearch-snapshot-config',
  );
  assert.match(
    job.spec.template.spec.containers[0].command.at(-1),
    /_slm\/policy\/wgo-daily/,
  );
  assert.match(
    job.spec.template.spec.containers[0].command.at(-1),
    /wgo-test-wgo-demo-es-snapshots/,
  );
});
