import { parsePostEvent } from './post-event.js';
import { parseUserEvent } from './user-event.js';
import { parseModerationEvent } from './moderation-event.js';
export const deadStreams: Record<string, string> = {
  'post:events': 'notification:post:dead',
  'user:events': 'notification:user:dead',
  'moderation:events': 'notification:moderation:dead',
  'moderation:report-events': 'notification:report:dead',
  'moderation:content-events': 'notification:content:dead',
};
export function replayFields(stream: string, entry: Record<string, string>) {
  if (!deadStreams[stream] || !entry.data || !entry.eventId)
    throw new Error('Invalid DLQ replay source');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(entry.data);
  } catch {
    throw new Error('Invalid DLQ JSON');
  }
  const fields = {
    eventId: entry.eventId,
    eventType: String(value.type ?? value.eventType),
    data: entry.data,
  };
  if (stream === 'post:events') parsePostEvent(fields.data, fields);
  else if (stream === 'user:events') parseUserEvent(fields);
  else parseModerationEvent(fields, stream);
  return fields;
}
