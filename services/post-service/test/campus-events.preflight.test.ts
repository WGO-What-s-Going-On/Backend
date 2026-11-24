import { describe, expect, it } from 'vitest';
import {
  validateCampusManifest,
  type CampusManifest,
} from '../src/post/infrastructure/campus-events.preflight.js';
const now = new Date();
function manifest(): CampusManifest {
  const names = ['notification-service', 'post-service', 'moderation-service'];
  const images = Object.fromEntries(
    names.map((n) => [n, `${n}@sha256:${'a'.repeat(64)}`]),
  );
  return {
    authorId: 42,
    expectedNickname: '머준',
    location: {
      building: 'CAU_SEOUL_203',
      latitude: 37.505,
      longitude: 126.958,
      sourceUrl: 'https://example.test/local-fixture',
      verifiedAt: now.toISOString(),
    },
    rollout: {
      context: 'local-fixture',
      namespace: 'wgo-demo',
      checkedAt: now.toISOString(),
      images,
      deployments: names.map((name) => ({
        metadata: { name, namespace: 'wgo-demo', generation: 2 },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: name } },
          template: {
            spec: { containers: [{ name: 'app', image: images[name] }] },
          },
        },
        status: {
          observedGeneration: 2,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
        },
      })),
      pods: names.map((name) => ({
        metadata: { namespace: 'wgo-demo', labels: { app: name } },
        spec: { containers: [{ name: 'app', image: images[name] }] },
        status: {
          phase: 'Running',
          containerStatuses: [{ name: 'app', ready: true }],
        },
      })),
    },
  };
}
describe('administrator creation rollout gate', () => {
  it.each(['Succeeded', 'Failed'])(
    'accepts a terminal %s Job without treating it as an old consumer',
    (phase) => {
      const m = manifest();
      const job = structuredClone(m.rollout!.pods[0]);
      job.metadata.ownerReferences = [{ kind: 'Job', name: 'local-migration' }];
      job.status.phase = phase;
      job.status.containerStatuses[0].ready = false;
      job.spec.containers[0].image = 'old-job';
      m.rollout!.pods.push(job);
      expect(validateCampusManifest(m, true, now)).toBe(m);
      job.status.phase = 'Running';
      expect(() => validateCampusManifest(m, true, now)).toThrow('Pods remain');
      job.status.phase = phase;
      job.metadata.ownerReferences = [
        { kind: 'ReplicaSet', name: 'old-consumer' },
      ];
      expect(() => validateCampusManifest(m, true, now)).toThrow('Pods remain');
    },
  );
  it('accepts only a fully rolled out three-consumer snapshot', () =>
    expect(validateCampusManifest(manifest(), true, now).authorId).toBe(42));
  it.each(['notification-service', 'post-service', 'moderation-service'])(
    'rejects even a terminating old %s Pod',
    (service) => {
      const m = manifest();
      const p = structuredClone(
        m.rollout!.pods.find((p) => p.metadata.labels.app === service),
      );
      p.metadata.deletionTimestamp = now.toISOString();
      p.spec.containers[0].image = 'old';
      m.rollout!.pods.push(p);
      expect(() => validateCampusManifest(m, true, now)).toThrow('Pods remain');
    },
  );
  it('rejects stale evidence and another nickname', () => {
    const m = manifest();
    m.rollout!.checkedAt = new Date(now.getTime() - 300001).toISOString();
    expect(() => validateCampusManifest(m, true, now)).toThrow('Fresh');
    expect(() =>
      validateCampusManifest({ ...m, expectedNickname: 'other' }, false),
    ).toThrow('authorId');
  });
});
