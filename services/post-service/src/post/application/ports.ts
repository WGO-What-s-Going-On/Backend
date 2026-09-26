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

// 작성 규칙 확인에 필요한 최소 조회와 API 응답용 조회를 분리한다.
export interface PostStateQueries {
  findPost(postId: string): Promise<PostState | null>;
  findCommentByMutation(postId: string, authorId: number, mutationId: string): Promise<CommentRecord | null>;
  findReaction(postId: string, userId: number): Promise<ReactionRecord | null>;
  findParticipant(postId: string, userId: number): Promise<ParticipantRecord | null>;
}

export type PostDetail = PostRecord;
export type CommentDetail = CommentRecord;
export type CommentCursor = { createdAt: Date; id: string };

export interface PostReadQueries {
  findDetail(postId: string): Promise<PostDetail | null>;
  findComments(postId: string, cursor: CommentCursor | null, limit: number): Promise<{ comment: CommentDetail; id: string }[]>;
  findActiveBatch(postIds: string[]): Promise<Pick<PostRecord, 'postId' | 'title' | 'category' | 'status' | 'createdAt'>[]>;
  findMeta(postId: string): Promise<Pick<PostRecord, 'postId' | 'status' | 'category' | 'locationSnapshot' | 'radiusM' | 'expiresAt'> | null>;
  findStatus(postId: string): Promise<Pick<PostRecord, 'postId' | 'status' | 'expiresAt'> | null>;
}

export interface PostCommands {
  insertPost(post: PostRecord): Promise<void>;
  insertComment(comment: CommentRecord, mutationId?: string): Promise<void>;
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
export const POST_READ_QUERIES = Symbol('POST_READ_QUERIES');
export const PARTICIPATION_AUTHORIZATION = Symbol('PARTICIPATION_AUTHORIZATION');
