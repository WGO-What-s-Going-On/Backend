import { readFileSync } from 'node:fs';

export const applications = [
  ['http-gateway', 8080, 'dist/src/server.js'],
  ['ws-gateway', 8081, 'dist/src/server.js'],
  ['user-service', 3001, 'dist/main.js'],
  ['post-service', 3002, 'dist/start.js'],
  ['map-service', 3003, 'dist/main.js'],
  ['notification-service', 3004, 'dist/main.js'],
  ['moderation-service', 3005, 'dist/main.js'],
];
export function validateEnvironment(config) {
  for (const key of ['project', 'cluster', 'namespace', 'staticIp'])
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(config[key] ?? ''))
      throw new Error(`Invalid ${key}`);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project))
    throw new Error('Invalid project ID');
  if (config.namespace.length > 16)
    throw new Error('Namespace must fit environment-scoped IAM account names');
  if (
    !Array.isArray(config.webOrigins) ||
    !config.webOrigins.length ||
    config.webOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== 'https:' || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error('Explicit HTTPS webOrigins required');
  for (const [name, version] of Object.entries(config.secretVersions ?? {})) {
    if (
      !applications.some(([app]) => app === name) ||
      !/^[1-9][0-9]*$/.test(version)
    )
      throw new Error('Invalid service secret version');
  }
  if (config.region !== 'asia-northeast3')
    throw new Error('Seoul region required');
  if (
    config.registry !== `asia-northeast3-docker.pkg.dev/${config.project}/wgo`
  )
    throw new Error('Registry must belong to configured project');
  if (
    !new RegExp(`^${config.project}:asia-northeast3:[a-z][a-z0-9-]+$`).test(
      config.sqlInstance,
    )
  )
    throw new Error('Invalid Cloud SQL instance');
  for (const name of ['domain', 'wsDomain'])
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(config[name] ?? ''))
      throw new Error(`Invalid ${name}`);
  if (config.domain === config.wsDomain)
    throw new Error('Gateway domains must differ');
  if (!/^[1-9][0-9]*$/.test(config.secretVersion ?? ''))
    throw new Error('Pin a numeric secret version');
  if (![1, 2, 3].includes(config.replicas))
    throw new Error('Demo replicas must be 1..3');
  return config;
}
export const readEnvironment = (path) =>
  validateEnvironment(JSON.parse(readFileSync(path, 'utf8')));
const limits = (cpu, memory) => ({
  requests: { cpu, memory, 'ephemeral-storage': '1Gi' },
  limits: { cpu, memory, 'ephemeral-storage': '1Gi' },
});
const meta = (name, namespace, extra = {}) => ({ name, namespace, ...extra });
const resource = (apiVersion, kind, name, namespace, spec) => ({
  apiVersion,
  kind,
  metadata: meta(name, namespace),
  ...spec,
});
export function serviceAccount(config, name) {
  return `${config.namespace}-${name.replace('-service', '').replace('-gateway', '-gw')}@${config.project}.iam.gserviceaccount.com`;
}
export function appResources(config, name, image) {
  validateEnvironment(config);
  const app = applications.find(([n]) => n === name);
  if (!app) throw new Error('Unknown application');
  if (
    !image.startsWith(`${config.registry}/${name}@sha256:`) ||
    !/sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error(
      'An immutable image in the configured registry is required',
    );
  const [, port, entry] = app;
  const ns = config.namespace;
  const secretVersion = config.secretVersions?.[name] ?? config.secretVersion;
  const account = serviceAccount(config, name);
  const settings = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(port),
    HTTP_PORT: String(port),
    LOG_PRETTY: 'false',
    CORS_ORIGINS: config.webOrigins.join(','),
    WS_ALLOWED_ORIGINS: config.webOrigins.join(','),
    NODE_EXTRA_CA_CERTS: '/app/certs/redis-ca.pem',
    DEPLOYMENT_ENV: 'staging',
    USER_GRPC_HOST: '0.0.0.0',
    USER_SERVICE_URL: 'http://user-service:3001',
    POST_SERVICE_URL: 'http://post-service:3002',
    MAP_SERVICE_URL: 'http://map-service:3003',
    NOTIFICATION_SERVICE_URL: 'http://notification-service:3004',
    MODERATION_SERVICE_URL: 'http://moderation-service:3005',
    MAP_GRPC_ADDRESS: 'map-service:50051',
    USER_GRPC_ADDRESS: 'user-service:50052',
  };
  const sql = ['user-service', 'notification-service'].includes(name);
  if (sql)
    Object.assign(settings, {
      DB_CONNECTION_MODE: 'cloud-sql-proxy',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_NAME: name === 'user-service' ? 'wgo_user' : 'wgo_notification',
      DB_USER: account.replace('.gserviceaccount.com', ''),
      DB_TLS_MODE: 'disable',
    });
  const volumes = [
    {
      name: 'runtime',
      csi: {
        driver: 'secrets-store-gke.csi.k8s.io',
        readOnly: true,
        volumeAttributes: { secretProviderClass: `${name}-runtime` },
      },
    },
    { name: 'bootstrap', configMap: { name: 'wgo-bootstrap' } },
    { name: 'certs', secret: { secretName: 'wgo-storage-tls' } },
  ];
  const container = {
    name: 'app',
    image,
    command: ['node', '/bootstrap/runtime.cjs', 'node', entry],
    envFrom: [{ configMapRef: { name: `${name}-config` } }],
    ports: [
      { name: 'http', containerPort: port },
      ...(name === 'map-service'
        ? [{ name: 'grpc', containerPort: 50051 }]
        : name === 'user-service'
          ? [{ name: 'grpc', containerPort: 50052 }]
          : []),
    ],
    volumeMounts: [
      { name: 'runtime', mountPath: '/var/run/wgo', readOnly: true },
      { name: 'bootstrap', mountPath: '/bootstrap', readOnly: true },
      { name: 'certs', mountPath: '/app/certs', readOnly: true },
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      runAsNonRoot: true,
      runAsUser: 1000,
    },
    resources: limits(
      name === 'post-service' ? '1000m' : '250m',
      name === 'post-service' ? '3Gi' : '512Mi',
    ),
    startupProbe: {
      httpGet: { path: '/health/live', port },
      periodSeconds: 5,
      failureThreshold: 60,
    },
    livenessProbe: {
      httpGet: { path: '/health/live', port },
      periodSeconds: 15,
      timeoutSeconds: 3,
    },
    readinessProbe: {
      httpGet: { path: '/health/ready', port },
      periodSeconds: 5,
      timeoutSeconds: 3,
    },
  };
  if (name === 'post-service') {
    volumes.push({
      name: 'es-ca',
      secret: { secretName: 'elasticsearch-es-http-certs-public' },
    });
    container.volumeMounts.push({
      name: 'es-ca',
      mountPath: '/app/es-certs',
      readOnly: true,
    });
    settings.NODE_EXTRA_CA_CERTS = '/trust/ca.pem';
    volumes.push({ name: 'trust', emptyDir: {} });
    container.volumeMounts.push({
      name: 'trust',
      mountPath: '/trust',
      readOnly: true,
    });
  }
  const pod = {
    serviceAccountName: name,
    terminationGracePeriodSeconds: 60,
    securityContext: {
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [container],
    volumes,
  };
  if (name === 'post-service')
    pod.initContainers = [
      {
        name: 'combine-trust',
        image: 'node:24-alpine',
        command: [
          'node',
          '-e',
          "const fs=require('fs');fs.writeFileSync('/trust/ca.pem',fs.readFileSync('/app/certs/redis-ca.pem','utf8')+'\\n'+fs.readFileSync('/app/es-certs/tls.crt','utf8'));",
        ],
        volumeMounts: container.volumeMounts
          .filter((m) => ['certs', 'es-ca', 'trust'].includes(m.name))
          .map((m) => ({ ...m, readOnly: m.name !== 'trust' })),
        securityContext: {
          runAsUser: 1000,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
        },
        resources: limits('250m', '256Mi'),
      },
    ];
  if (sql)
    pod.initContainers = [
      {
        name: 'cloud-sql-proxy',
        image: 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.18.2',
        restartPolicy: 'Always',
        args: [
          '--auto-iam-authn',
          '--private-ip',
          '--structured-logs',
          '--health-check',
          '--http-address=0.0.0.0',
          '--port=5432',
          config.sqlInstance,
        ],
        securityContext: {
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
        },
        resources: limits('250m', '256Mi'),
        startupProbe: {
          httpGet: { path: '/startup', port: 9090 },
          periodSeconds: 2,
          failureThreshold: 30,
        },
        livenessProbe: {
          httpGet: { path: '/liveness', port: 9090 },
          periodSeconds: 10,
        },
      },
    ];
  const items = [
    resource('v1', 'ServiceAccount', name, ns, {
      metadata: meta(name, ns, {
        annotations: { 'iam.gke.io/gcp-service-account': account },
      }),
    }),
    resource(
      'secrets-store.csi.x-k8s.io/v1',
      'SecretProviderClass',
      `${name}-runtime`,
      ns,
      {
        spec: {
          provider: 'gke',
          parameters: {
            secrets: `- resourceName: "projects/${config.project}/secrets/${ns}-${name}-runtime/versions/${secretVersion}"\n  path: "runtime.json"\n`,
          },
        },
      },
    ),
    resource('v1', 'ConfigMap', `${name}-config`, ns, { data: settings }),
    resource('apps/v1', 'Deployment', name, ns, {
      spec: {
        replicas: config.replicas,
        revisionHistoryLimit: 5,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
        },
        selector: { matchLabels: { app: name } },
        template: {
          metadata: {
            labels: { app: name, 'wgo/component': 'application' },
            annotations: { 'wgo/secret-version': secretVersion },
          },
          spec: pod,
        },
      },
    }),
    resource('v1', 'Service', name, ns, {
      metadata: meta(
        name,
        ns,
        name.includes('gateway')
          ? {
              annotations: {
                'cloud.google.com/neg': '{"ingress":true}',
                'cloud.google.com/backend-config': JSON.stringify({
                  default: name,
                }),
              },
            }
          : {},
      ),
      spec: {
        type: 'ClusterIP',
        selector: { app: name },
        ports: container.ports.map((p) => ({
          name: p.name,
          port: p.containerPort,
          targetPort: p.name,
        })),
      },
    }),
  ];
  if (name === 'notification-service') {
    const cleanupPod = structuredClone(pod);
    cleanupPod.restartPolicy = 'Never';
    const cleanup = cleanupPod.containers[0];
    cleanup.command = [
      'node',
      '/bootstrap/runtime.cjs',
      'node',
      'dist/persistence/cleanup.js',
    ];
    delete cleanup.startupProbe;
    delete cleanup.livenessProbe;
    delete cleanup.readinessProbe;
    items.push(
      resource('batch/v1', 'CronJob', 'notification-service-expiry', ns, {
        spec: {
          schedule: '*/5 * * * *',
          concurrencyPolicy: 'Forbid',
          successfulJobsHistoryLimit: 1,
          failedJobsHistoryLimit: 2,
          jobTemplate: {
            spec: {
              backoffLimit: 1,
              activeDeadlineSeconds: 120,
              template: {
                metadata: { labels: { app: name } },
                spec: cleanupPod,
              },
            },
          },
        },
      }),
    );
  }
  return items;
}
export function migrationJob(config, name, image, suffix) {
  if (
    !['user-service', 'notification-service'].includes(name) ||
    !/^[a-f0-9]{8,40}$/.test(suffix)
  )
    throw new Error('Invalid migration target');
  const deployment = appResources(config, name, image).find(
    (r) => r.kind === 'Deployment',
  );
  const pod = structuredClone(deployment.spec.template.spec);
  const app = pod.containers[0];
  app.command = [
    'node',
    '/bootstrap/runtime.cjs',
    'node',
    ...(name === 'user-service'
      ? [
          'node_modules/typeorm/cli.js',
          'migration:run',
          '-d',
          'dist/database/data-source.js',
        ]
      : ['dist/persistence/migrate.js']),
  ];
  delete app.startupProbe;
  delete app.livenessProbe;
  delete app.readinessProbe;
  pod.restartPolicy = 'Never';
  return resource(
    'batch/v1',
    'Job',
    `${name}-migrate-${suffix}`,
    config.namespace,
    {
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 300,
        ttlSecondsAfterFinished: 86400,
        template: {
          metadata: { labels: { app: name, 'wgo/component': 'application' } },
          spec: pod,
        },
      },
    },
  );
}
export function foundation(config) {
  const ns = config.namespace;
  const out = [
    resource('v1', 'Namespace', ns, undefined, {}),
    resource('v1', 'ConfigMap', 'wgo-bootstrap', ns, {
      data: {
        'runtime.cjs': readFileSync(
          new URL('../deploy/gke/runtime.cjs', import.meta.url),
          'utf8',
        ),
      },
    }),
  ];
  for (const [name, port] of applications.filter(([n]) =>
    n.includes('gateway'),
  ))
    out.push(
      resource('cloud.google.com/v1', 'BackendConfig', name, ns, {
        spec: {
          timeoutSec: name === 'ws-gateway' ? 3600 : 30,
          connectionDraining: { drainingTimeoutSec: 60 },
          healthCheck: { type: 'HTTP', requestPath: '/health/ready', port },
        },
      }),
    );
  out.push(
    resource('networking.gke.io/v1', 'ManagedCertificate', 'wgo', ns, {
      spec: { domains: [config.domain, config.wsDomain] },
    }),
  );
  out.push(
    resource('networking.gke.io/v1beta1', 'FrontendConfig', 'wgo', ns, {
      spec: { redirectToHttps: { enabled: true } },
    }),
  );
  out.push(
    resource('networking.k8s.io/v1', 'Ingress', 'wgo', ns, {
      metadata: meta('wgo', ns, {
        annotations: {
          'kubernetes.io/ingress.class': 'gce',
          'kubernetes.io/ingress.global-static-ip-name': config.staticIp,
          'networking.gke.io/managed-certificates': 'wgo',
          'networking.gke.io/v1beta1.FrontendConfig': 'wgo',
        },
      }),
      spec: {
        rules: [
          [config.domain, 'http-gateway', 8080],
          [config.wsDomain, 'ws-gateway', 8081],
        ].map(([host, name, port]) => ({
          host,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name, port: { number: port } } },
              },
            ],
          },
        })),
      },
    }),
  );
  // Limit inbound app/storage access to this namespace and the GCLB health/proxy ranges.
  out.push(
    resource('networking.k8s.io/v1', 'NetworkPolicy', 'wgo-ingress', ns, {
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [{ from: [{ podSelector: {} }] }],
      },
    }),
  );
  out.push(
    resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      'gateways-from-load-balancer',
      ns,
      {
        spec: {
          podSelector: {
            matchExpressions: [
              {
                key: 'app',
                operator: 'In',
                values: ['http-gateway', 'ws-gateway'],
              },
            ],
          },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                { ipBlock: { cidr: '130.211.0.0/22' } },
                { ipBlock: { cidr: '35.191.0.0/16' } },
              ],
              ports: [
                { protocol: 'TCP', port: 8080 },
                { protocol: 'TCP', port: 8081 },
              ],
            },
          ],
        },
      },
    ),
  );
  out.push(
    resource(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      'elasticsearch-operator',
      ns,
      {
        spec: {
          podSelector: {
            matchLabels: {
              'elasticsearch.k8s.elastic.co/cluster-name': 'elasticsearch',
            },
          },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'elastic-system',
                    },
                  },
                },
              ],
              ports: [{ protocol: 'TCP', port: 9200 }],
            },
          ],
        },
      },
    ),
  );
  return out;
}
