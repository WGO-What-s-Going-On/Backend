import type { DataSource } from 'typeorm';

import { TermEntity } from '../entities/term.entity.js';

const DOCUMENT_ENVIRONMENTS = [
  ['SERVICE', 'TERMS_SERVICE_DOCUMENT_URL'],
  ['PRIVACY_COLLECTION_USE', 'TERMS_PRIVACY_DOCUMENT_URL'],
  ['LOCATION', 'TERMS_LOCATION_DOCUMENT_URL'],
] as const;

export function readTermsSeed(environment: NodeJS.ProcessEnv) {
  const version = environment.TERMS_VERSION?.trim() ?? '1.0';
  const effectiveAtText =
    environment.TERMS_EFFECTIVE_AT?.trim() ?? '2026-09-01T00:00:00.000Z';
  const effectiveAt = new Date(effectiveAtText);

  if (!version || version.length > 100) {
    throw new Error('TERMS_VERSION must contain 1 to 100 characters');
  }
  if (
    Number.isNaN(effectiveAt.getTime()) ||
    effectiveAt.toISOString() !== effectiveAtText
  ) {
    throw new Error(
      'TERMS_EFFECTIVE_AT must be a UTC timestamp such as 2026-09-01T00:00:00.000Z',
    );
  }
  if (effectiveAt.getTime() > Date.now()) {
    throw new Error(
      'TERMS_EFFECTIVE_AT must not be in the future for initial terms provisioning',
    );
  }

  return DOCUMENT_ENVIRONMENTS.map(([code, name]) => {
    const documentUrl = environment[name]?.trim();
    if (!documentUrl) {
      throw new Error(`${name} is required to seed terms`);
    }
    let url: URL;
    try {
      url = new URL(documentUrl);
    } catch {
      throw new Error(
        `${name} must be an absolute HTTPS URL without credentials`,
      );
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(
        `${name} must be an absolute HTTPS URL without credentials`,
      );
    }
    return {
      code,
      version,
      required: true,
      documentUrl,
      effectiveAt,
      createdAt: new Date(),
    };
  });
}

export async function provisionTerms(
  dataSource: DataSource,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const terms = readTermsSeed(environment);

  await dataSource.transaction(async (manager) => {
    const repository = manager.getRepository(TermEntity);
    await repository
      .createQueryBuilder()
      .insert()
      .values(terms)
      .orIgnore()
      .execute();

    // Existing consent IDs must continue to identify the same published version.
    // A mismatched rerun fails atomically instead of silently keeping stale URLs.
    for (const term of terms) {
      const stored = await repository.findOneByOrFail({
        code: term.code,
        version: term.version,
      });
      if (
        stored.documentUrl !== term.documentUrl ||
        stored.required !== term.required ||
        stored.effectiveAt.getTime() !== term.effectiveAt.getTime()
      ) {
        throw new Error(
          `Terms ${term.code} version ${term.version} already exists with different values; publish a new TERMS_VERSION`,
        );
      }
    }
  });
}
