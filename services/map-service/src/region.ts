import { validCoordinates } from './location.js';
export async function resolveRegion(latitude: number, longitude: number) {
  if (!validCoordinates(latitude, longitude))
    throw new Error('Invalid coordinates');
  const key = process.env.KAKAO_LOCAL_REST_API_KEY;
  if (!key) throw new Error('Kakao Local key is required');
  const url = new URL(
    'https://dapi.kakao.com/v2/local/geo/coord2regioncode.json',
  );
  url.searchParams.set('x', String(longitude));
  url.searchParams.set('y', String(latitude));
  const response = await fetch(url, {
    headers: { Authorization: `KakaoAK ${key}` },
    signal: AbortSignal.timeout(1500),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Region provider unavailable');
  const result = (await response.json()) as {
    documents?: {
      region_type?: unknown;
      code?: unknown;
      address_name?: unknown;
    }[];
  };
  // H means administrative district; B is the legal district and cannot distinguish all administrative dongs.
  const region = result.documents?.find((row) => row.region_type === 'H');
  if (
    !region ||
    typeof region.code !== 'string' ||
    !/^[0-9]{10}$/.test(region.code) ||
    typeof region.address_name !== 'string'
  )
    throw new Error('Administrative district unavailable');
  return { code: region.code, name: region.address_name };
}
