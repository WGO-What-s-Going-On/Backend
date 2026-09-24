import type { CommentRecord, ParticipantRecord, PostRecord, PostState, ReactionRecord } from '../domain/post.js';

export type EventType = 'PostCreated' | 'PostCommentCreated' | 'PostReactionCreated' | 'PostParticipantJoined';

export interface OutboxEvent {
  eventId: string;
  aggregateId: string;
  eventType: EventType;
  schemaVersion: 1;
  producer: 'post-service';
  correlationId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

// Queries required by the create commands; no general read API is exposed yet.
export interface PostStateQueries {
  findPost(postId: string): Promise<PostState | null>;
  findReaction(postId: string, userId: number): Promise<ReactionRecord | null>;
  findParticipant(postId: string, userId: number): Promise<ParticipantRecord | null>;
}

export interface PostCommands {
  insertPost(post: PostRecord): Promise<void>;
  insertComment(comment: CommentRecord): Promise<void>;
  insertReaction(reaction: ReactionRecord): Promise<void>;
  insertParticipant(participant: ParticipantRecord): Promise<void>;
  rejoinParticipant(participant: ParticipantRecord): Promise<ParticipantRecord | null>;
  increment(postId: string, counter: 'commentCount' | 'reactionCount' | 'participantCount', now: Date): Promise<void>;
  appendEvent(event: OutboxEvent): Promise<void>;
}

export interface PostTransaction {
  queries: PostStateQueries;
  commands: PostCommands;
}

export interface PostUnitOfWork {
  execute<T>(work: (transaction: PostTransaction) => Promise<T>): Promise<T>;
}

export interface ParticipationAuthorization {
  assertCanJoin(postId: string, userId: number): Promise<void>;
}

export const POST_UNIT_OF_WORK = Symbol('POST_UNIT_OF_WORK');
export const POST_STATE_QUERIES = Symbol('POST_STATE_QUERIES');
export const PARTICIPATION_AUTHORIZATION = Symbol('PARTICIPATION_AUTHORIZATION');
