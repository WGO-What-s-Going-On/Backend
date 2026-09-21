import dataSource from '../data-source.js';
import { TermEntity } from '../entities/term.entity.js';

const EFFECTIVE_AT = new Date('2026-09-01T00:00:00.000Z');

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required to seed terms`);
  }

  return value;
}

async function seedTerms(): Promise<void> {
  const terms = [
    {
      code: 'SERVICE',
      version: '1.0',
      required: true,
      documentUrl: requiredEnvironment('TERMS_SERVICE_DOCUMENT_URL'),
      effectiveAt: EFFECTIVE_AT,
      createdAt: new Date(),
    },
    {
      code: 'PRIVACY_COLLECTION_USE',
      version: '1.0',
      required: true,
      documentUrl: requiredEnvironment('TERMS_PRIVACY_DOCUMENT_URL'),
      effectiveAt: EFFECTIVE_AT,
      createdAt: new Date(),
    },
    {
      code: 'LOCATION',
      version: '1.0',
      required: true,
      documentUrl: requiredEnvironment('TERMS_LOCATION_DOCUMENT_URL'),
      effectiveAt: EFFECTIVE_AT,
      createdAt: new Date(),
    },
  ];

  await dataSource.initialize();

  try {
    await dataSource
      .createQueryBuilder()
      .insert()
      .into(TermEntity)
      .values(terms)
      .orIgnore()
      .execute();
  } finally {
    await dataSource.destroy();
  }
}

seedTerms().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
