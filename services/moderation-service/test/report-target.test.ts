import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ReportTarget } from '../src/reports/report-target.js';
import { ReportReason } from '../src/reports/report.dto.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('authenticates as Moderation and sends only target context, not reporter or description', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    input = {
      targetType: 'POST' as const,
      postId: 'post_test',
      reason: ReportReason.SPAM,
      description: 'private report',
    };
  vi.stubEnv(
    'MODERATION_POST_REPORT_TARGET_URL',
    'http://post/internal/v1/moderation/report-target',
  );
  vi.stubEnv(
    'MODERATION_SERVICE_PRIVATE_JWK',
    JSON.stringify({
      ...pair.privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'mod-1',
    }),
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      verified: true,
      targetType: 'POST',
      postId: 'post_test',
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  await new ReportTarget().verify(input);
  const options = fetchMock.mock.calls[0]![1],
    parts = options.headers.authorization.slice(7).split('.');
  expect(
    verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    ),
  ).toBe(true);
  expect(JSON.parse(options.body)).toEqual({
    targetType: 'POST',
    postId: 'post_test',
  });
  fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
  await expect(new ReportTarget().verify(input)).rejects.toMatchObject({
    status: 404,
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ verified: true, targetType: 'POST', postId: 'wrong' }),
  });
  await expect(new ReportTarget().verify(input)).rejects.toMatchObject({
    status: 503,
  });
});
