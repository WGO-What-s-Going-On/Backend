// GEO와 증명 메타데이터를 같은 Redis 명령에서 검사한다. 연결 성공만으로 완전성을 가정하지 않는다.
export const GEO_STATE = 'map:posts:geo:state';
export const GEO_DIRTY = 'map:posts:geo:dirty';
export const beginGeoWrite = `
redis.call('SADD', KEYS[2], ARGV[1])
return redis.call('HINCRBY', KEYS[1], 'revision', 1)
`;

// 조회 시 감지한 유실은 유지한다. 이후 쓰기로 멤버 수만 맞아져도 정상으로 복귀시키지 않는다.
export const inspectGeo = `
local active = redis.call('GET', KEYS[1])
local key = active or ARGV[1]
local ready = redis.call('HGET', KEYS[3], 'ready') == '1'
if not active or redis.call('HGET', KEYS[3], 'key') ~= key or
   tonumber(redis.call('HGET', KEYS[3], 'count') or '-1') ~= redis.call('ZCARD', key) then
  ready = false
  redis.call('HSET', KEYS[3], 'ready', '0')
end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('SCARD', KEYS[4]) > 0 then ready = false end
local ids = redis.call('GEOSEARCH', key, 'FROMLONLAT', ARGV[2], ARGV[3], 'BYRADIUS', ARGV[4], 'm', 'COUNT', ARGV[5] or '2000000000')
return {ready and 1 or 0, ids}
`;

export const beforeGeoMutation = `
local active = redis.call('GET', KEYS[1]) or ARGV[1]
if redis.call('HGET', KEYS[3], 'key') ~= active or
   tonumber(redis.call('HGET', KEYS[3], 'count') or '-1') ~= redis.call('ZCARD', active) then
  redis.call('HSET', KEYS[3], 'ready', '0')
end
`;
export const afterGeoMutation = `
redis.call('HSET', KEYS[3], 'count', redis.call('ZCARD', active))
return 1
`;
