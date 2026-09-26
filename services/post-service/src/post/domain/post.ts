export type PostStatus = 'ACTIVE' | 'EXPIRED' | 'DELETED';

export interface PostState {
  postId: string;
  status: PostStatus;
}

export interface PostInput {
  title: string;
  content: string;
  category: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

export interface PostRecord extends PostState {
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
  commentId: string;
  postId: string;
  authorId: number;
  content: string;
  status: 'ACTIVE';
  createdAt: Date;
  updatedAt: Date | null;
}

export interface ReactionRecord {
  postId: string;
  userId: number;
  type: 'LIKE';
  createdAt: Date;
}

export interface ParticipantRecord {
  postId: string;
  userId: number;
  joinedAt: Date;
  lastSeenAt: Date;
  leftAt: Date | null;
}

export class PostNotFoundError extends Error {}
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

export function requireActive(
  post: PostState | null,
): asserts post is PostState {
  if (!post) throw new PostNotFoundError('Post not found');
  if (post.status !== 'ACTIVE')
    throw new PostInactiveError('Post is not active');
}

export function createPost(
  input: PostInput,
  authorId: number,
  postId: string,
  now: Date,
): PostRecord {
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
): CommentRecord {
  requireText(content, 'content', 2000);
  return {
    commentId,
    postId,
    authorId,
    content,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: null,
  };
}

export function createReaction(
  postId: string,
  userId: number,
  now: Date,
): ReactionRecord {
  return { postId, userId, type: 'LIKE', createdAt: now };
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
