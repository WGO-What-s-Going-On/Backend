import { createHash } from 'node:crypto';

export interface PartitionStrategy {
  resolveBucket(entityId: string, bucketCount: number): number;
}

export class HashPartitionStrategy implements PartitionStrategy {
  resolveBucket(entityId: string, bucketCount: number): number {
    if (!Number.isSafeInteger(bucketCount) || bucketCount < 1)
      throw new Error('bucketCount must be a positive integer');
    if (bucketCount === 1) return 0;
    const hash = createHash('sha256').update(entityId).digest().readUInt32BE(0);
    return hash % bucketCount;
  }
}

export const PARTITION_STRATEGY = Symbol('PARTITION_STRATEGY');
