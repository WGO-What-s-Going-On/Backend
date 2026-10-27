import { mediaIds as validateMediaIds } from '../media/media.policy.js';
export type PostStatus = 'ACTIVE' | 'EXPIRED' | 'DELETED';

export interface PostState {
  postId: string;
  status: PostStatus;
  bucketCount: number;
  authorId: number;
  category: string;
  expiresAt: Date | null;
  postVersion: number;
  locationSnapshot?: { latitude: number; longitude: number };
  radiusM?: number;
}

export interface PostInput {
  mediaIds?: string[];
  title: string;
  content: string;
  category: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

export interface PostRecord {
  mediaIds?: string[];
  postId: string;
  status: PostStatus;
  authorId: number;
  category: string;
  title: string;
  content: string;
  locationSnapshot: { latitude: number; longitude: number };
  radiusM: number;
  counters: {
    viewCount: number;
    commentCount: number;
    reactionCount: number;
    participantCount: number;
  };
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

export interface CommentRecord {
  mediaIds?: string[];
  commentId: string;
  postId: string;
  authorId: number;
  content: string;
  status: 'ACTIVE' | 'DELETED';
  createdAt: Date;
  updatedAt: Date | null;
}

export enum CommentReactionType {
  HELPFUL = 'HELPFUL',
  AGREE = 'AGREE',
  DIFFERENT = 'DIFFERENT',
}

export type CommentReactionCounts = Record<CommentReactionType, number>;

export function emptyCommentReactionCounts(): CommentReactionCounts {
  return { HELPFUL: 0, AGREE: 0, DIFFERENT: 0 };
}

export interface CommentReactionRecord {
  postId: string;
  commentId: string;
  userId: number;
  type: CommentReactionType;
  createdAt: Date;
}

export function createCommentReaction(
  postId: string,
  commentId: string,
  userId: number,
  type: CommentReactionType,
  now: Date,
): CommentReactionRecord {
  return { postId, commentId, userId, type, createdAt: now };
}

export enum PostReactionType {
  CURIOUS = 'CURIOUS',
  STILL_HAPPENING = 'STILL_HAPPENING',
  HELPFUL = 'HELPFUL',
  ENDED = 'ENDED',
}

// 이전 LIKE 기록은 새로 만들지 않지만 취소와 이벤트 재발행을 위해 읽을 수 있어야 한다.
export type StoredPostReactionType = PostReactionType | 'LIKE';

export interface ReactionRecord {
  postId: string;
  userId: number;
  type: StoredPostReactionType;
  createdAt: Date;
}

export class ReactionConflictError extends Error {}

// 이미 고른 종류를 다시 누르는 것은 재시도이고, 다른 종류는 취소 후에만 선택할 수 있다.
export function requireReactionSlot<T extends { type: string }>(
  active: T | null,
  requested: string,
): T | null {
  if (active && active.type !== requested)
    throw new ReactionConflictError(
      'Cancel the current reaction before choosing another',
    );
  return active;
}

export interface ParticipantRecord {
  postId: string;
  userId: number;
  joinedAt: Date;
  lastSeenAt: Date;
  leftAt: Date | null;
}

export class PostNotFoundError extends Error {}
export class PostOwnershipError extends Error {}
export class PostInactiveError extends Error {}
export class InvalidPostError extends Error {}

function requireText(value: string, name: string, max: number): void {
  if (!value || value.length > max)
    throw new InvalidPostError(`${name} is required (max ${max} characters)`);
}

function requireRange(
  value: number,
  name: string,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new InvalidPostError(`${name} must be between ${min} and ${max}`);
}

export function requireActive<
  T extends { status: PostStatus; expiresAt?: Date | null },
>(post: T | null): asserts post is T {
  if (!post) throw new PostNotFoundError('Post not found');
  if (
    post.status !== 'ACTIVE' ||
    (post.expiresAt && post.expiresAt.getTime() <= Date.now())
  )
    throw new PostInactiveError('Post is not active');
}

export function createPost(
  input: PostInput,
  authorId: number,
  postId: string,
  now: Date,
): PostRecord {
  const attachments = validateMediaIds(input.mediaIds);
  requireText(input.title, 'title', 120);
  requireText(input.content, 'content', 5000);
  requireText(input.category, 'category', 40);
  if (!/^[A-Z][A-Z_]*$/.test(input.category))
    throw new InvalidPostError('Invalid category');
  requireRange(input.latitude, 'latitude', -90, 90);
  requireRange(input.longitude, 'longitude', -180, 180);
  requireRange(input.radiusM, 'radiusM', 1, 10000);
  return {
    postId,
    authorId,
    ...(attachments.length ? { mediaIds: attachments } : {}),
    title: input.title,
    content: input.content,
    category: input.category,
    status: 'ACTIVE',
    locationSnapshot: { latitude: input.latitude, longitude: input.longitude },
    radiusM: input.radiusM,
    counters: {
      viewCount: 0,
      commentCount: 0,
      reactionCount: 0,
      participantCount: 0,
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  };
}

export function createComment(
  postId: string,
  authorId: number,
  content: string,
  commentId: string,
  now: Date,
  attachments: string[] = [],
): CommentRecord {
  const ids = validateMediaIds(attachments);
  requireText(content, 'content', 2000);
  return {
    commentId,
    postId,
    authorId,
    ...(ids.length ? { mediaIds: ids } : {}),
    content,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: null,
  };
}

export function createReaction(
  postId: string,
  userId: number,
  type: PostReactionType,
  now: Date,
): ReactionRecord {
  return { postId, userId, type, createdAt: now };
}

export function joinParticipant(
  existing: ParticipantRecord | null,
  postId: string,
  userId: number,
  now: Date,
): { participant: ParticipantRecord; joined: boolean } {
  if (existing?.leftAt === null)
    return { participant: existing, joined: false };
  return {
    participant: {
      postId,
      userId,
      joinedAt: now,
      lastSeenAt: now,
      leftAt: null,
    },
    joined: true,
  };
}
