import { afterEach, expect, it, vi } from 'vitest';
import { resolveRegion } from '../src/region.js';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('selects administrative H instead of legal B and keeps coordinate order', async () => {
  vi.stubEnv('KAKAO_LOCAL_REST_API_KEY', 'test');
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        documents: [
          {
            region_type: 'B',
            code: '1159010200',
            address_name: '서울 동작구 상도동',
          },
          {
            region_type: 'H',
            code: '1159053000',
            address_name: '서울 동작구 상도1동',
          },
        ],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await resolveRegion(37.5, 126.9)).toEqual({
    code: '1159053000',
    name: '서울 동작구 상도1동',
  });
  const url = fetcher.mock.calls[0]![0] as URL;
  expect(url.searchParams.get('x')).toBe('126.9');
  expect(url.searchParams.get('y')).toBe('37.5');
});
it('does not guess a district when the provider fails', async () => {
  vi.stubEnv('KAKAO_LOCAL_REST_API_KEY', 'test');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('', { status: 503 })),
  );
  await expect(resolveRegion(37.5, 126.9)).rejects.toThrow('unavailable');
  await expect(resolveRegion(91, 126.9)).rejects.toThrow('coordinates');
});
