import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type { GcsProfileImageStorage } from '../src/users/profile-image/gcs-profile-image.storage.js';

export type FakeObject = {
  bytes: Buffer;
  contentType: string;
  generation: string;
  declaredSize?: number;
};
const missing = () => Object.assign(new Error('missing'), { code: 404 });

// Byte-level GCS test double. No real signing, IAM, CRC transport or CORS is exercised.
export class FakeGcs {
  objects = new Map<string, FakeObject>();
  signed: Array<Record<string, unknown>> = [];
  copyResponseLost = false;
  unavailable = false;
  generation = 1;
  put(key: string, bytes: Buffer, contentType = 'image/png') {
    this.objects.set(key, {
      bytes,
      contentType,
      generation: String(this.generation++),
    });
  }
  bind(storage: GcsProfileImageStorage) {
    Object.defineProperty(storage, 'config', {
      value: { enabled: true, bucket: 'test-profiles' },
    });
    vi.spyOn(storage.client, 'bucket').mockImplementation(
      () =>
        ({
          file: (key: string, options?: { generation: string }) =>
            this.file(key, options?.generation),
        }) as never,
    );
  }
  file(key: string, generation?: string) {
    const object = () => {
      if (this.unavailable) throw new Error('GCS unavailable');
      const value = this.objects.get(key);
      if (!value || (generation && generation !== value.generation))
        throw missing();
      return value;
    };
    return {
      name: key,
      getMetadata: async () => {
        const value = object();
        return [
          {
            contentType: value.contentType,
            size: value.declaredSize ?? value.bytes.length,
            generation: value.generation,
          },
        ];
      },
      createReadStream: () => Readable.from([object().bytes]),
      getSignedUrl: async (options: Record<string, unknown>) => {
        if (this.unavailable) throw new Error('signer unavailable');
        this.signed.push({ key, ...options });
        return [`https://storage.invalid/${key}?fake-signature=redacted`];
      },
      copy: async (
        target: { name: string },
        options: { preconditionOpts: { ifGenerationMatch: number } },
      ) => {
        const value = object();
        if (options.preconditionOpts.ifGenerationMatch !== 0)
          throw new Error('Missing create-only precondition');
        if (this.objects.has(target.name))
          throw Object.assign(new Error('exists'), { code: 412 });
        this.put(target.name, value.bytes, value.contentType);
        if (this.copyResponseLost) {
          this.copyResponseLost = false;
          throw new Error('copy response lost');
        }
      },
      delete: async () => {
        if (this.unavailable) throw new Error('delete unavailable');
        this.objects.delete(key);
      },
    };
  }
}
