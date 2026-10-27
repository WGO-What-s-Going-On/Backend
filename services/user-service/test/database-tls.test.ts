import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { databaseTls } from '../src/database/tls.js';
import { createTypeOrmOptions } from '../src/database/typeorm.config.js';

const directory = mkdtempSync(join(tmpdir(), 'wgo-db-tls-'));
const caPath = join(directory, 'ca.pem');
writeFileSync(caPath, rootCertificates[0]!);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
describe('database TLS', () => {
  it('keeps local non-TLS and enforces production TLS', () => {
    expect(databaseTls({})).toBe(false);
    expect(() => databaseTls({ NODE_ENV: 'production' })).toThrow(
      'verify-full',
    );
    expect(() => databaseTls({ DB_TLS_MODE: 'require' })).toThrow(
      'DB_TLS_MODE',
    );
    expect(() => databaseTls({ DB_TLS_MODE: 'verify-full' })).toThrow(
      'DB_TLS_CA_PATH',
    );
  });
  it('rejects missing, malformed and private-key bundles', () => {
    for (const value of [
      '',
      'not a certificate',
      `${rootCertificates[0]}\n-----BEGIN PRIVATE KEY-----`,
    ]) {
      const path = join(directory, 'invalid.pem');
      writeFileSync(path, value);
      expect(() =>
        databaseTls({ DB_TLS_MODE: 'verify-full', DB_TLS_CA_PATH: path }),
      ).toThrow('readable PEM');
    }
    expect(() =>
      databaseTls({
        DB_TLS_MODE: 'verify-full',
        DB_TLS_CA_PATH: join(directory, 'absent'),
      }),
    ).toThrow('readable PEM');
  });
  it('passes the verified CA to the application driver', () => {
    const ssl = databaseTls({
      NODE_ENV: 'production',
      DB_TLS_MODE: 'verify-full',
      DB_TLS_CA_PATH: caPath,
    });
    expect(ssl).toEqual({ ca: rootCertificates[0], rejectUnauthorized: true });
    const config = new ConfigService({
      database: {
        host: 'db.example',
        port: 5432,
        username: 'test',
        password: 'test',
        name: 'test',
        ssl,
      },
    });
    expect(createTypeOrmOptions(config)).toMatchObject({ ssl });
  });
});
