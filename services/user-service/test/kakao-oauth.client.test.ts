import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KakaoOAuthClient } from '../src/auth/kakao-oauth.client.js';

describe('KakaoOAuthClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges the authorization code using the Kakao form contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'kakao-access-token' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient();
    await expect(
      client.exchangeAuthorizationCode('authorization-code'),
    ).resolves.toBe('kakao-access-token');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://kauth.kakao.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect((init.body as URLSearchParams).toString()).toBe(
      'grant_type=authorization_code&client_id=kakao-rest-api-key&redirect_uri=https%3A%2F%2Fexample.test%2Fcallback&code=authorization-code&client_secret=kakao-client-secret',
    );
  });

  it('reads a numeric Kakao id without losing integer precision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"id":900719925474099312345,"connected_at":"2026-01-01"}', {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient();
    await expect(client.getUserId('kakao-access-token')).resolves.toBe(
      '900719925474099312345',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kapi.kakao.com/v2/user/me',
      {
        headers: { authorization: 'Bearer kakao-access-token' },
      },
    );
  });

  it('maps Kakao and network failures to unauthorized', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new Error('network unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient();
    await expect(
      client.exchangeAuthorizationCode('invalid'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(client.getUserId('token')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a response without a top-level Kakao id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"kakao_account":{"id":123}}', { status: 200 }),
        ),
    );

    await expect(createClient().getUserId('token')).rejects.toMatchObject({
      status: 401,
    });
  });
});

function createClient(redirectUris?: string): KakaoOAuthClient {
  return new KakaoOAuthClient(
    new ConfigService({
      auth: {
        kakao: {
          restApiKey: 'kakao-rest-api-key',
          clientSecret: 'kakao-client-secret',
          redirectUri: 'https://example.test/callback',
          redirectUris,
        },
      },
    }),
  );
}

it.each([
  'http://localhost:5173/auth/kakao/callback',
  'https://example.test/callback',
])('exchanges with the exact requested allowlisted URI %s', async (uri) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response('{"access_token":"token"}'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await createClient(
      'https://example.test/callback,http://localhost:5173/auth/kakao/callback',
    ).exchangeAuthorizationCode('code', uri);
    expect(fetchMock.mock.calls[0]?.[1].body.get('redirect_uri')).toBe(uri);
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  'https://evil.test/callback',
  'https://example.test/callback/extra',
  'https://example.test/callback?next=evil',
  ' https://example.test/callback',
  '',
])('rejects unapproved URI before contacting Kakao: %s', async (uri) => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(
      createClient().exchangeAuthorizationCode('code', uri),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  '',
  'https://*.example.test',
  'http://example.test/callback',
  'https://a:b@example.test/callback',
  'https://example.test/callback#fragment',
])('rejects unsafe allowlist configuration %s', (uri) => {
  expect(() => createClient(uri)).toThrow();
});
