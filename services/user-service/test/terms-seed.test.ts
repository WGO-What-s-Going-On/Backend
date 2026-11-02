import { describe, expect, it } from 'vitest';

import { readTermsSeed } from '../src/database/seeds/terms-seed.js';

const environment = {
  TERMS_SERVICE_DOCUMENT_URL: 'https://example.test/service',
  TERMS_PRIVACY_DOCUMENT_URL: 'https://example.test/privacy',
  TERMS_LOCATION_DOCUMENT_URL: 'https://example.test/location',
  TERMS_EFFECTIVE_AT: '2020-01-01T00:00:00.000Z',
};

describe('terms seed configuration', () => {
  it.each([
    '',
    'not a url',
    'http://example.test/terms',
    'javascript:alert(1)',
    'https://user:password@example.test/terms',
  ])('rejects an invalid document URL %s', (documentUrl) => {
    expect(() =>
      readTermsSeed({
        ...environment,
        TERMS_SERVICE_DOCUMENT_URL: documentUrl,
      }),
    ).toThrow('TERMS_SERVICE_DOCUMENT_URL');
  });

  it.each([
    '',
    'not a date',
    '2026-02-30T00:00:00.000Z',
    '2026-01-01',
    '2999-01-01T00:00:00.000Z',
  ])('rejects a malformed or future effective date %s', (date) => {
    expect(() =>
      readTermsSeed({ ...environment, TERMS_EFFECTIVE_AT: date }),
    ).toThrow('TERMS_EFFECTIVE_AT');
  });

  it.each(['', ' ', 'a'.repeat(101)])(
    'rejects invalid version %s',
    (version) => {
      expect(() =>
        readTermsSeed({ ...environment, TERMS_VERSION: version }),
      ).toThrow('TERMS_VERSION');
    },
  );
});
