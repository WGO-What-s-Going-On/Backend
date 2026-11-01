// Queue work before committing state and its immutable journal in one HSET.
// A partial Lua failure may leave a harmless queue entry, never an undiscoverable
// committed report. A publication receipt must precede every later event.
export const reportScript = `
local action,lookup,userId=ARGV[1],ARGV[2],ARGV[3]
for i,expected in ipairs({'hash','set','stream'}) do
  local kind=redis.call('TYPE',KEYS[i]).ok
  if kind~='none' and kind~=expected then return redis.error_reply('REPORT_WRONGTYPE') end
end
local function result(code,report)
  return cjson.encode({code=code,report=report})
end
local function validate(record)
  local r=record.report
  if record.format~=1 or record.stream~=KEYS[3] or type(r)~='table'
    or type(r.reportId)~='string' or type(r.reporterUserId)~='string'
    or type(record.events)~='table' or #record.events<1 or #record.events>2
    or (r.status~='PENDING' and r.status~='WITHDRAWN' and r.status~='REVIEWED')
    or (r.status=='WITHDRAWN')~=(#record.events==2) then error('REPORT_INVALID_RECORD') end
  local previous=true
  for i,item in ipairs(record.events) do
    local e=item.envelope
    local expected=i==1 and 'REPORT_CREATED' or 'REPORT_WITHDRAWN'
    if type(e)~='table' or e.eventType~=expected or type(e.eventId)~='string'
      or e.schemaVersion~=1 or e.producer~='moderation-service'
      or e.data.reportId~=r.reportId or e.data.reporterUserId~=r.reporterUserId
      or e.data.postId~=r.postId or e.data.targetType~=r.targetType
      or e.data.commentId~=r.commentId or type(e.occurredAt)~='string'
      or (item.streamId and (type(item.streamId)~='string' or not previous)) then error('REPORT_INVALID_EVENT') end
    previous=item.streamId~=nil
  end
end
local function publish(record,digest)
  for _,item in ipairs(record.events) do
    if not item.streamId then
      local e=item.envelope
      local streamId=redis.call('XADD',KEYS[3],'*','eventId',e.eventId,'eventType',e.eventType,'data',cjson.encode(e))
      -- fault:after-xadd
      item.streamId=streamId
      redis.call('HSET',KEYS[1],'target:'..digest,cjson.encode(record))
    end
  end
  -- fault:after-receipt
  redis.call('SREM',KEYS[2],digest)
end
local digest=lookup
if action=='withdraw' then
  digest=redis.call('HGET',KEYS[1],'id:'..lookup)
  if not digest then return result('NOT_FOUND') end
end
local raw=redis.call('HGET',KEYS[1],'target:'..digest)
local record=nil
if raw then
  record=cjson.decode(raw)
  validate(record)
  if action=='withdraw' and (record.report.reportId~=lookup or record.report.reporterUserId~=userId) then return result('NOT_FOUND') end
  if action~='recover' and record.report.reporterUserId~=userId then error('REPORT_IDENTITY_MISMATCH') end
  publish(record,digest)
elseif action~='create' then
  if action=='recover' then redis.call('SREM',KEYS[2],digest) end
  return result('NOT_FOUND')
end
local function envelope(r,eventType)
  local data={reportId=r.reportId,reporterUserId=r.reporterUserId,targetType=r.targetType,postId=r.postId,commentId=r.commentId}
  if eventType=='REPORT_CREATED' then data.reason=r.reason else data.withdrawnAt=r.withdrawnAt end
  return {eventId=ARGV[5],eventType=eventType,schemaVersion=1,producer='moderation-service',occurredAt=ARGV[6],data=data}
end
if action=='create' then
  if record then
    if record.report.status=='WITHDRAWN' then return result('WITHDRAWN') end
  else
    local r=cjson.decode(ARGV[4])
    if redis.call('HEXISTS',KEYS[1],'id:'..r.reportId)==1 then error('REPORT_ID_COLLISION') end
    record={format=1,stream=KEYS[3],report=r,events={{envelope=envelope(r,'REPORT_CREATED')}}}
    validate(record)
    redis.call('SADD',KEYS[2],digest)
    -- fault:before-state
    redis.call('HSET',KEYS[1],'target:'..digest,cjson.encode(record),'id:'..r.reportId,digest)
    -- fault:after-state
    publish(record,digest)
  end
elseif action=='withdraw' then
  local r=record.report
  if r.status=='REVIEWED' then return result('REVIEWED') end
  if r.status~='WITHDRAWN' then
    r.status='WITHDRAWN'; r.withdrawnAt=ARGV[6]
    table.insert(record.events,{envelope=envelope(r,'REPORT_WITHDRAWN')})
    validate(record)
    redis.call('SADD',KEYS[2],digest)
    -- fault:before-state
    redis.call('HSET',KEYS[1],'target:'..digest,cjson.encode(record))
    -- fault:after-state
    publish(record,digest)
  end
end
return result('OK',record.report)
`;
