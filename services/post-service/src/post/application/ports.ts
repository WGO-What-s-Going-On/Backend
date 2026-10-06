import type {
  CommentRecord,
  ParticipantRecord,
  PostRecord,
  PostState,
  ReactionRecord,
} from '../domain/post.js';

export type EventType =
  | 'PostCreated'
  | 'PostCommentCreated'
  | 'PostReactionCreated'
  | 'PostParticipantJoined'
  | 'PostReactionRemoved'
  | 'PostCommentDeleted'
  | 'PostDeleted'
  | 'PostParticipantLeft'
  | 'PostExpired';

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

export type StoredActivity<T> = T & {
  activityVersion?: number;
  bucketId?: number;
};
export type StoredReaction = StoredActivity<ReactionRecord> & {
  removedAt?: Date | null;
};

// 작성 규칙 확인에 필요한 최소 조회와 API 응답용 조회를 분리한다.
export interface PostStateQueries {
  findPost(postId: string): Promise<PostState | null>;
  findCommentByMutation(
    postId: string,
    authorId: number,
    mutationId: string,
  ): Promise<CommentRecord | null>;
  findComment(
    postId: string,
    commentId: string,
  ): Promise<StoredActivity<CommentRecord> | null>;
  findReaction(postId: string, userId: number): Promise<StoredReaction | null>;
  findParticipant(
    postId: string,
    userId: number,
  ): Promise<StoredActivity<ParticipantRecord> | null>;
}

export type PostDetail = PostRecord;
export type CommentDetail = CommentRecord;
export type CommentCursor = { createdAt: Date; id: string };

export interface PostReadQueries {
  findDetail(postId: string): Promise<PostDetail | null>;
  findComments(
    postId: string,
    cursor: CommentCursor | null,
    limit: number,
  ): Promise<{ comment: CommentDetail; id: string }[]>;
  findActiveBatch(
    postIds: string[],
  ): Promise<
    Pick<PostRecord, 'postId' | 'title' | 'category' | 'status' | 'createdAt'>[]
  >;
  findMeta(
    postId: string,
  ): Promise<Pick<
    PostRecord,
    | 'postId'
    | 'status'
    | 'category'
    | 'locationSnapshot'
    | 'radiusM'
    | 'expiresAt'
  > | null>;
  findStatus(
    postId: string,
  ): Promise<Pick<PostRecord, 'postId' | 'status' | 'expiresAt'> | null>;
}

export interface PostCommands {
  insertPost(post: PostRecord): Promise<void>;
  insertComment(
    comment: CommentRecord & { bucketId: number },
    mutationId?: string,
  ): Promise<void>;
  insertReaction(
    reaction: ReactionRecord & { bucketId: number },
  ): Promise<void>;
  insertParticipant(participant: ParticipantRecord): Promise<void>;
  rejoinParticipant(
    participant: ParticipantRecord,
    activityVersion: number,
  ): Promise<ParticipantRecord | null>;
  reactivateReaction(
    reaction: ReactionRecord,
    activityVersion: number,
  ): Promise<void>;
  removeReaction(
    postId: string,
    userId: number,
    now: Date,
    activityVersion: number,
  ): Promise<void>;
  deleteComment(
    postId: string,
    commentId: string,
    now: Date,
    activityVersion: number,
  ): Promise<void>;
  leaveParticipant(
    postId: string,
    userId: number,
    now: Date,
    activityVersion: number,
  ): Promise<void>;
  fenceActivities(postId: string, bucketCount: number): Promise<void>;
  changePostStatus(
    postId: string,
    status: 'DELETED' | 'EXPIRED',
    now: Date,
    postVersion: number,
  ): Promise<void>;
  scheduleExpiration(postId: string, expiresAt: Date, now: Date): Promise<void>;
  increment(
    postId: string,
    bucketId: number,
    counter: 'commentCount' | 'reactionCount' | 'participantCount',
    delta?: number,
  ): Promise<void>;
  appendEvent(event: OutboxEvent): Promise<void>;
}

export interface PostTransaction {
  queries: PostStateQueries;
  commands: PostCommands;
}

export interface PostUnitOfWork {
  execute<T>(work: (transaction: PostTransaction) => Promise<T>): Promise<T>;
}

export interface LocationAuthorization {
  assertCanCreate(
    userId: number,
    latitude: number,
    longitude: number,
    radiusM: number,
  ): Promise<void>;
  assertCanJoin(
    userId: number,
    postId: string,
    latitude: number,
    longitude: number,
    radiusM: number,
  ): Promise<void>;
}

export const POST_UNIT_OF_WORK = Symbol('POST_UNIT_OF_WORK');
export const POST_STATE_QUERIES = Symbol('POST_STATE_QUERIES');
export const POST_READ_QUERIES = Symbol('POST_READ_QUERIES');
export const LOCATION_AUTHORIZATION = Symbol('LOCATION_AUTHORIZATION');

// Map 공간 조회 계약을 재사용한다. 유사도 검색은 첫 페이지 한 번만 요청한다.
export interface NearbyPostsQuery {
  latitude: number;
  longitude: number;
  radiusM: 150 | 250 | 350;
  limit: number;
  cursor?: string;
}
export interface NearbyPostsPage {
  items: { postId: string; distanceM: number }[];
  truncated: boolean;
  nextCursor: string | null;
}
export interface NearbyPostsQueryPort {
  page(query: NearbyPostsQuery): Promise<NearbyPostsPage>;
}
