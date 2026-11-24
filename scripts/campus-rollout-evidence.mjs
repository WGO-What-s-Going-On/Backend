// Read-only deployment gate. Emits no environment variables, Secrets or credentials.
import { execFileSync } from 'node:child_process';
const [context, namespace, postImage, moderationImage, notificationImage] =
  process.argv.slice(2);
if (
  !context ||
  namespace !== 'wgo-demo' ||
  ![postImage, moderationImage, notificationImage].every((s) =>
    /@sha256:[a-f0-9]{64}$/.test(s ?? ''),
  )
)
  throw new Error(
    'Usage: campus-rollout-evidence.mjs <explicit-context> wgo-demo <reviewed-post-image@sha256:...> <reviewed-moderation-image@sha256:...> <reviewed-notification-image@sha256:...>',
  );
const get = (...args) =>
  JSON.parse(
    execFileSync(
      'kubectl',
      ['--context', context, '-n', namespace, 'get', ...args, '-o', 'json'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ),
  );
const deployments = get(
  'deployment',
  'post-service',
  'moderation-service',
  'notification-service',
).items.map((d) => ({
  metadata: {
    name: d.metadata.name,
    namespace: d.metadata.namespace,
    generation: d.metadata.generation,
    resourceVersion: d.metadata.resourceVersion,
  },
  spec: {
    replicas: d.spec.replicas,
    selector: d.spec.selector,
    template: {
      spec: {
        containers: d.spec.template.spec.containers.map(({ name, image }) => ({
          name,
          image,
        })),
      },
    },
  },
  status: {
    observedGeneration: d.status.observedGeneration,
    updatedReplicas: d.status.updatedReplicas,
    readyReplicas: d.status.readyReplicas,
    availableReplicas: d.status.availableReplicas,
    unavailableReplicas: d.status.unavailableReplicas ?? 0,
  },
}));
const pods = get('pods')
  .items.filter((p) =>
    deployments.some((d) =>
      Object.entries(d.spec.selector.matchLabels).every(
        ([k, v]) => p.metadata.labels?.[k] === v,
      ),
    ),
  )
  .map((p) => ({
    metadata: {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      labels: p.metadata.labels,
      deletionTimestamp: p.metadata.deletionTimestamp,
    },
    spec: {
      containers: p.spec.containers.map(({ name, image }) => ({ name, image })),
    },
    status: {
      phase: p.status.phase,
      containerStatuses: p.status.containerStatuses?.map(({ name, ready }) => ({
        name,
        ready,
      })),
    },
  }));
console.log(
  JSON.stringify(
    {
      context,
      namespace,
      checkedAt: new Date().toISOString(),
      images: {
        'post-service': postImage,
        'moderation-service': moderationImage,
        'notification-service': notificationImage,
      },
      deployments,
      pods,
    },
    null,
    2,
  ),
);
