import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationBlockChecker } from '../src/notification/block-checker.js';
afterEach(() => vi.unstubAllGlobals());
it('signs a scoped service identity and strictly validates the authority response', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    jwk = {
      ...pair.privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'notification-1',
    };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      recipientId: '1',
      recipientActive: true,
      actors: [{ actorId: '2', blocked: false }],
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const checker = new NotificationBlockChecker(
    new ConfigService({
      blocks: {
        url: 'http://user/internal/notifications/blocks/check',
        privateJwk: JSON.stringify(jwk),
      },
    }),
  );
  expect(await checker.allowed('1', '2')).toBe(true);
  const options = fetchMock.mock.calls[0]![1],
    token = options.headers.authorization.slice(7).split('.');
  expect(
    verify(
      'sha256',
      Buffer.from(`${token[0]}.${token[1]}`),
      { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(token[2], 'base64url'),
    ),
  ).toBe(true);
  expect(
    JSON.parse(Buffer.from(token[1], 'base64url').toString()),
  ).toMatchObject({ iss: 'wgo-notification-service', aud: 'wgo-user-service' });
  expect(JSON.parse(options.body)).toEqual({
    recipientId: '1',
    actorIds: ['2'],
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ recipientId: '1', recipientActive: true, actors: [] }),
  });
  await expect(checker.allowed('1', '2')).rejects.toThrow(
    'Invalid User block response',
  );
  expect(await checker.allowed('1', '1')).toBe(false);
});
it('does not assume unblocked when the authority is unconfigured', async () => {
  await expect(
    new NotificationBlockChecker(new ConfigService()).allowed('1', '2'),
  ).rejects.toThrow('unavailable');
});
