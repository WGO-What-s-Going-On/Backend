import type { PostEvent } from './post-event.js';

export const POST_EVENT_PROCESSOR = Symbol('POST_EVENT_PROCESSOR');

export interface PostEventProcessor {
  process(event: PostEvent): Promise<void>;
}
