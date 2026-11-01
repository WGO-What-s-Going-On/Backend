import { readFileSync } from 'node:fs';

const script = (file) =>
  readFileSync(
    new URL(`../deploy/gke/storage-${file}`, import.meta.url),
    'utf8',
  );
const resources = (cpu, memory) => ({
  requests: { cpu, memory, 'ephemeral-storage': '1Gi' },
  limits: { cpu, memory, 'ephemeral-storage': '1Gi' },
});
const mount = (name, mountPath, readOnly = true) => ({
  name,
  mountPath,
  readOnly,
});
const secret = (name, secretName, keys) => ({
  name,
  secret: {
    secretName,
    ...(keys ? { items: keys.map((key) => ({ key, path: key })) } : {}),
  },
});

export function storageResources(config) {
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project) ||
    config.region !== 'asia-northeast3' ||
    !/^[a-z][a-z0-9-]{2,62}$/.test(config.namespace)
  )
    throw new Error('Invalid storage environment');
  const ns = config.namespace;
  const object = (apiVersion, kind, name, fields) => ({
    apiVersion,
    kind,
    metadata: { name, namespace: ns },
    ...fields,
  });
  const service = (name, port) =>
    object('v1', 'Service', name, {
      spec: {
        clusterIP: 'None',
        publishNotReadyAddresses: true,
        selector: { app: name },
        ports: [{ name: 'database', port }],
      },
    });
  const stateful = (name, image, port, memory, size, extra) =>
    object('apps/v1', 'StatefulSet', name, {
      spec: {
        serviceName: name,
        replicas: 1,
        persistentVolumeClaimRetentionPolicy: {
          whenDeleted: 'Retain',
          whenScaled: 'Retain',
        },
        selector: { matchLabels: { app: name } },
        template: {
          metadata: {
            labels: {
              app: name,
              'wgo/component': 'storage',
              'wgo/backup': 'databases',
            },
          },
          spec: {
            terminationGracePeriodSeconds: 120,
            securityContext: {
              fsGroup: name === 'redis' ? 1000 : 999,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name,
                image,
                ports: [{ containerPort: port }],
                resources: resources('1000m', memory),
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                ...extra.container,
              },
            ],
            volumes: extra.volumes,
            ...(extra.initContainers
              ? { initContainers: extra.initContainers }
              : {}),
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'data', labels: { 'wgo/backup': 'databases' } },
            spec: {
              accessModes: ['ReadWriteOnce'],
              storageClassName: 'premium-rwo',
              resources: { requests: { storage: size } },
            },
          },
        ],
      },
    });
  const result = [
    object('v1', 'ConfigMap', 'wgo-storage-bootstrap', {
      data: {
        'mongo-start.sh': script('mongo-start.sh'),
        'mongo-init.js': script('mongo-init.js'),
        'mongo-smoke.js': script('mongo-smoke.js'),
        'redis-start.sh': script('redis-start.sh'),
        'cassandra-start.sh': script('cassandra-start.sh'),
        'cassandra-config.py': script('cassandra-config.py'),
        'schema.cql': readFileSync(
          new URL('../services/map-service/schema.cql', import.meta.url),
          'utf8',
        ),
      },
    }),
  ];
  const bootstrap = {
    name: 'bootstrap',
    configMap: { name: 'wgo-storage-bootstrap', defaultMode: 365 },
  };
  result.push(
    service('mongodb', 27017),
    stateful('mongodb', 'mongo:8.0.17', 27017, '2Gi', '20Gi', {
      container: {
        command: ['/bin/sh', '/bootstrap/mongo-start.sh'],
        securityContext: {
          runAsUser: 999,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
          mount('data', '/data/db', false),
          mount('bootstrap', '/bootstrap'),
          mount('credentials', '/credentials'),
          mount('private', '/private'),
        ],
        startupProbe: {
          tcpSocket: { port: 27017 },
          periodSeconds: 5,
          failureThreshold: 60,
        },
        readinessProbe: {
          exec: {
            command: [
              'mongosh',
              '--quiet',
              '--tls',
              '--tlsCAFile',
              '/private/ca.pem',
              '--host',
              'localhost',
              '--eval',
              'quit(db.hello().isWritablePrimary ? 0 : 1)',
            ],
          },
          periodSeconds: 10,
          timeoutSeconds: 5,
        },
        livenessProbe: { tcpSocket: { port: 27017 }, periodSeconds: 15 },
      },
      volumes: [
        bootstrap,
        secret('credentials', 'wgo-storage-credentials', [
          'mongodb-root-password',
          'mongodb-post-password',
        ]),
        secret('source-tls', 'mongodb-server-tls'),
        { name: 'private', emptyDir: { medium: 'Memory' } },
      ],
      initContainers: [
        {
          name: 'private-key-permissions',
          image: 'mongo:8.0.17',
          command: ['sh', '-c', 'cp /source/* /private/; chmod 400 /private/*'],
          securityContext: {
            runAsUser: 999,
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
          },
          resources: resources('250m', '256Mi'),
          volumeMounts: [
            mount('source-tls', '/source'),
            mount('private', '/private', false),
          ],
        },
      ],
    }),
  );
  result.push(
    service('redis', 6379),
    stateful('redis', 'redis:8.0.4', 6379, '1Gi', '10Gi', {
      container: {
        command: ['sh', '/bootstrap/redis-start.sh'],
        securityContext: {
          runAsUser: 1000,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
          mount('data', '/data', false),
          mount('bootstrap', '/bootstrap'),
          mount('tls', '/tls'),
          mount('credentials', '/credentials'),
        ],
        readinessProbe: {
          exec: {
            command: [
              'sh',
              '-c',
              'REDISCLI_AUTH="$(cat /credentials/redis-password)" redis-cli --tls --cacert /tls/ca.pem -h localhost ping | grep -qx PONG',
            ],
          },
          periodSeconds: 10,
          timeoutSeconds: 3,
        },
        livenessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 15 },
      },
      volumes: [
        bootstrap,
        secret('credentials', 'wgo-storage-credentials', ['redis-password']),
        secret('tls', 'redis-server-tls'),
      ],
    }),
  );
  result.push(
    service('cassandra', 9042),
    stateful('cassandra', 'cassandra:4.1.10', 9042, '4Gi', '20Gi', {
      container: {
        command: ['bash', '/bootstrap/cassandra-start.sh'],
        securityContext: {
          runAsUser: 999,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
        },
        env: [
          { name: 'CASSANDRA_CLUSTER_NAME', value: 'wgo-demo' },
          { name: 'CASSANDRA_DC', value: 'datacenter1' },
          {
            name: 'CASSANDRA_ENDPOINT_SNITCH',
            value: 'GossipingPropertyFileSnitch',
          },
          { name: 'MAX_HEAP_SIZE', value: '2G' },
          { name: 'HEAP_NEWSIZE', value: '512M' },
        ],
        volumeMounts: [
          mount('data', '/var/lib/cassandra', false),
          mount('bootstrap', '/bootstrap'),
          mount('tls', '/tls'),
          mount('credentials', '/credentials'),
        ],
        startupProbe: {
          tcpSocket: { port: 9042 },
          periodSeconds: 5,
          failureThreshold: 120,
        },
        readinessProbe: {
          exec: {
            command: [
              'cqlsh',
              '--ssl',
              '--cqlshrc',
              '/tmp/cqlshrc',
              'localhost',
              '9042',
              '-e',
              'SELECT post_id FROM wgo_map.post_status LIMIT 1',
            ],
          },
          periodSeconds: 20,
          timeoutSeconds: 10,
        },
        livenessProbe: { tcpSocket: { port: 9042 }, periodSeconds: 15 },
      },
      volumes: [
        bootstrap,
        secret('tls', 'cassandra-server-tls'),
        secret('credentials', 'wgo-storage-credentials', [
          'cassandra-admin-password',
          'cassandra-map-password',
          'cassandra-keystore-password',
        ]),
      ],
    }),
  );
  result.push(
    object('v1', 'ServiceAccount', 'elasticsearch-snapshot', {
      metadata: {
        name: 'elasticsearch-snapshot',
        namespace: ns,
        annotations: {
          'iam.gke.io/gcp-service-account': `${ns}-es-snapshots@${config.project}.iam.gserviceaccount.com`,
        },
      },
    }),
  );
  result.push(
    object(
      'elasticsearch.k8s.elastic.co/v1',
      'Elasticsearch',
      'elasticsearch',
      {
        spec: {
          version: '8.19.4',
          volumeClaimDeletePolicy: 'DeleteOnScaledownOnly',
          nodeSets: [
            {
              name: 'default',
              count: 1,
              config: { 'node.store.allow_mmap': false },
              podTemplate: {
                metadata: { labels: { 'wgo/component': 'storage' } },
                spec: {
                  serviceAccountName: 'elasticsearch-snapshot',
                  containers: [
                    {
                      name: 'elasticsearch',
                      resources: resources('1000m', '2Gi'),
                      env: [{ name: 'ES_JAVA_OPTS', value: '-Xms1g -Xmx1g' }],
                    },
                  ],
                },
              },
              volumeClaimTemplates: [
                {
                  metadata: { name: 'elasticsearch-data' },
                  spec: {
                    accessModes: ['ReadWriteOnce'],
                    storageClassName: 'premium-rwo',
                    resources: { requests: { storage: '20Gi' } },
                  },
                },
              ],
            },
          ],
        },
      },
    ),
  );
  for (const entry of result) {
    if (
      entry.kind === 'StatefulSet' ||
      entry.kind === 'Service' ||
      entry.kind === 'ConfigMap'
    )
      entry.metadata.labels = { 'wgo/backup': 'databases' };
  }
  result.push(
    object('gkebackup.gke.io/v1', 'ProtectedApplication', 'wgo-databases', {
      spec: {
        resourceSelection: {
          type: 'Selector',
          selector: { matchLabels: { 'wgo/backup': 'databases' } },
        },
        components: ['mongodb', 'redis', 'cassandra'].map((name) => ({
          name,
          resourceKind: 'StatefulSet',
          resourceNames: [name],
          strategy: { type: 'BackupAllRestoreAll', backupAllRestoreAll: {} },
        })),
      },
    }),
  );
  const snapshotCommands = `set -eu
request() {
  curl --silent --show-error --fail --retry 30 --retry-all-errors --retry-delay 10 --retry-max-time 600 --connect-timeout 5 --max-time 30 --cacert /tls/tls.crt -u "elastic:$(cat /credentials/elastic)" -H 'Content-Type: application/json' -X PUT "https://elasticsearch-es-http:9200/$1" -d "$2"
}
request _snapshot/wgo-gcs '{"type":"gcs","settings":{"bucket":"${config.project}-${ns}-es-snapshots","base_path":"${ns}"}}'
request _slm/policy/wgo-daily '{"schedule":"0 30 18 * * ?","name":"<wgo-{now/d}>","repository":"wgo-gcs","config":{"indices":["post-semantic-*"],"include_global_state":false},"retention":{"expire_after":"14d","min_count":7,"max_count":30}}'
`;
  result.push(
    object('batch/v1', 'Job', 'elasticsearch-snapshot-config', {
      spec: {
        backoffLimit: 2,
        activeDeadlineSeconds: 1200,
        template: {
          spec: {
            restartPolicy: 'Never',
            securityContext: {
              fsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'configure',
                image: 'curlimages/curl:8.12.1',
                command: ['sh', '-c', snapshotCommands],
                resources: resources('250m', '256Mi'),
                securityContext: {
                  runAsUser: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  mount('tls', '/tls'),
                  mount('credentials', '/credentials'),
                ],
              },
            ],
            volumes: [
              secret('tls', 'elasticsearch-es-http-certs-public'),
              secret('credentials', 'elasticsearch-es-elastic-user'),
            ],
          },
        },
      },
    }),
  );
  return result;
}
