export interface CampusManifest {
  authorId: number;
  expectedNickname: string;
  location: {
    latitude: number;
    longitude: number;
    building: string;
    sourceUrl: string;
    verifiedAt: string;
  };
  rollout?: {
    context: string;
    namespace: string;
    checkedAt: string;
    images: Record<string, string>;
    deployments: any[];
    pods: any[];
  };
}

// Read-only kubectl snapshots are supplied by the operator after completing rollout.
// An old consumer sharing the stream could initialize a campaign without its policy.
export function validateCampusManifest(
  raw: unknown,
  apply: boolean,
  now = new Date(),
): CampusManifest {
  const m = raw as CampusManifest;
  if (
    !m ||
    !Number.isSafeInteger(m.authorId) ||
    m.authorId <= 0 ||
    m.expectedNickname !== '머준'
  )
    throw new Error(
      'Approved authorId and exact expectedNickname are required',
    );
  const p = m.location;
  if (
    !p ||
    p.building !== 'CAU_SEOUL_203' ||
    !Number.isFinite(p.latitude) ||
    !Number.isFinite(p.longitude) ||
    p.latitude < 37.5 ||
    p.latitude > 37.51 ||
    p.longitude < 126.95 ||
    p.longitude > 126.97 ||
    !/^https:\/\//.test(p.sourceUrl) ||
    !Number.isFinite(Date.parse(p.verifiedAt)) ||
    Date.parse(p.verifiedAt) > now.getTime()
  )
    throw new Error(
      'Verified Seorabeol Hall 203 coordinates and source evidence are required',
    );
  if (!apply) return m;
  const r = m.rollout;
  if (
    !r ||
    !r.context ||
    r.namespace !== 'wgo-demo' ||
    !Number.isFinite(Date.parse(r.checkedAt)) ||
    now.getTime() - Date.parse(r.checkedAt) > 300000 ||
    Date.parse(r.checkedAt) > now.getTime()
  )
    throw new Error(
      'Fresh deployment/Pod rollout evidence is required for apply',
    );
  for (const service of [
    'notification-service',
    'post-service',
    'moderation-service',
  ]) {
    const image = r.images[service];
    const d = r.deployments.find((v) => v.metadata?.name === service);
    if (
      !/@sha256:[a-f0-9]{64}$/.test(image ?? '') ||
      !d ||
      d.metadata.namespace !== r.namespace ||
      d.metadata.generation !== d.status?.observedGeneration ||
      !(d.spec.replicas > 0) ||
      d.status.updatedReplicas !== d.spec.replicas ||
      d.status.readyReplicas !== d.spec.replicas ||
      d.status.availableReplicas !== d.spec.replicas ||
      (d.status.unavailableReplicas ?? 0) !== 0 ||
      d.spec.template.spec.containers.find((c: any) => c.name === 'app')
        ?.image !== image
    )
      throw new Error(`Incomplete ${service} rollout`);
    const labels = d.spec.selector.matchLabels;
    if (!labels || !Object.keys(labels).length)
      throw new Error('Deployment selector is required');
    const pods = r.pods.filter((v) =>
      Object.entries(labels).every(
        ([k, value]) => v.metadata?.labels?.[k] === value,
      ),
    );
    if (
      pods.length !== d.spec.replicas ||
      pods.some(
        (v) =>
          v.metadata.namespace !== r.namespace ||
          v.metadata.deletionTimestamp ||
          v.status?.phase !== 'Running' ||
          v.spec.containers.find((c: any) => c.name === 'app')?.image !==
            image ||
          !v.status.containerStatuses?.find((c: any) => c.name === 'app')
            ?.ready,
      )
    )
      throw new Error(`Old, terminating or unready ${service} Pods remain`);
  }
  return m;
}
