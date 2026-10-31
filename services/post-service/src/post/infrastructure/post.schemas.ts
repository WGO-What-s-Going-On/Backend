import { Schema } from 'mongoose';
import { CommentReactionType, PostReactionType } from '../domain/post.js';

const options = { versionKey: false, strict: true } as const;

export const PostSchema = new Schema(
  {
    postId: { type: String, required: true, unique: true },
    mediaIds: { type: [String], default: [] },
    authorId: { type: Number, required: true },
    anonymous: { type: Boolean, default: false },
    category: { type: String, required: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, required: true },
    region: { code: String, name: String },
    locationSnapshot: { latitude: Number, longitude: Number },
    radiusM: { type: Number, required: true },
    counters: {
      viewCount: Number,
      commentCount: Number,
      reactionCount: Number,
      participantCount: Number,
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    voteAt: { type: Date, default: null },
    vote: { type: Schema.Types.Mixed, default: null },
    voteRevision: { type: Number, default: 0 },
    bucketCount: { type: Number, required: true, default: 1 },
    postVersion: { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
  },
  options,
);
PostSchema.index({ 'region.code': 1, 'vote.status': 1 });
PostSchema.index({ authorId: 1, createdAt: -1, _id: -1 });
PostSchema.index({ status: 1, expiresAt: 1 });
PostSchema.index({ 'vote.status': 1, voteAt: 1 });

export const VoteSelectionSchema = new Schema(
  {
    postId: { type: String, required: true },
    userId: { type: Number, required: true },
    commentId: { type: String, default: null },
    updatedAt: { type: Date, required: true },
  },
  options,
);
VoteSelectionSchema.index({ userId: 1, updatedAt: -1, _id: -1 });
VoteSelectionSchema.index({ postId: 1, userId: 1 }, { unique: true });

export const CommentSchema = new Schema(
  {
    commentId: { type: String, required: true, unique: true },
    mediaIds: { type: [String], default: [] },
    postId: { type: String, required: true },
    bucketId: { type: Number, required: true, default: 0 },
    authorId: { type: Number, required: true },
    parentCommentId: { type: String, default: null },
    verified: { type: Boolean, default: false },
    mutationId: { type: String },
    activityVersion: { type: Number, default: 1 },
    voteSelectionFence: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
    content: { type: String, required: true },
    status: { type: String, required: true },
    reactionCounts: {
      HELPFUL: { type: Number, default: 0 },
      AGREE: { type: Number, default: 0 },
      DIFFERENT: { type: Number, default: 0 },
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, default: null },
  },
  options,
);
CommentSchema.index({ authorId: 1, status: 1, createdAt: -1, _id: -1 });
CommentSchema.index({ postId: 1, bucketId: 1, createdAt: -1, _id: -1 });
// 기존 HTTP 댓글에는 mutationId가 없으므로 값이 있는 WS 요청에만 유일성을 적용한다.
CommentSchema.index(
  { postId: 1, authorId: 1, mutationId: 1 },
  {
    unique: true,
    partialFilterExpression: { mutationId: { $type: 'string' } },
  },
);

export const ReactionSchema = new Schema(
  {
    postId: { type: String, required: true },
    bucketId: { type: Number, required: true, default: 0 },
    userId: { type: Number, required: true },
    // LIKE는 이전 데이터와 미발행 Outbox 재처리를 위해서만 저장 허용한다.
    type: {
      type: String,
      required: true,
      enum: [...Object.values(PostReactionType), 'LIKE'],
    },
    activityVersion: { type: Number, default: 1 },
    removedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  options,
);
ReactionSchema.index({ userId: 1, removedAt: 1, createdAt: -1, _id: -1 });
ReactionSchema.index({ postId: 1, userId: 1, type: 1 }, { unique: true });
// 취소 이력은 남기되 같은 사용자의 활성 게시물 공감은 하나만 허용한다.
ReactionSchema.index(
  { postId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { removedAt: null } },
);

export const CommentReactionSchema = new Schema(
  {
    postId: { type: String, required: true },
    commentId: { type: String, required: true },
    userId: { type: Number, required: true },
    type: {
      type: String,
      required: true,
      enum: Object.values(CommentReactionType),
    },
    createdAt: { type: Date, required: true },
    removedAt: { type: Date, default: null },
    activityVersion: { type: Number, default: 1 },
  },
  options,
);
CommentReactionSchema.index({
  userId: 1,
  removedAt: 1,
  createdAt: -1,
  _id: -1,
});
CommentReactionSchema.index(
  { commentId: 1, userId: 1, type: 1 },
  { unique: true },
);
CommentReactionSchema.index(
  { commentId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { removedAt: null } },
);

export const CounterSchema = new Schema(
  {
    postId: { type: String, required: true },
    bucketId: { type: Number, required: true },
    metric: { type: String, required: true },
    count: { type: Number, required: true },
    lifecycleFence: { type: Number, default: 0 },
  },
  options,
);
CounterSchema.index({ postId: 1, bucketId: 1, metric: 1 }, { unique: true });

export const ParticipantSchema = new Schema(
  {
    postId: { type: String, required: true },
    userId: { type: Number, required: true },
    joinedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    activityVersion: { type: Number, default: 1 },
    leftAt: { type: Date, default: null },
  },
  options,
);
ParticipantSchema.index({ postId: 1, userId: 1 }, { unique: true });
ParticipantSchema.index({ postId: 1, joinedAt: -1 });

export const OutboxSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    aggregateId: { type: String, required: true },
    eventType: { type: String, required: true },
    schemaVersion: { type: Number, required: true },
    producer: { type: String, required: true },
    correlationId: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true },
    claimedBy: { type: String, default: null },
    claimedUntil: { type: Date, default: null },
    attemptCount: { type: Number, default: 0 },
    totalAttempts: { type: Number, default: 0 },
    replayCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    failedAt: { type: Date, default: null },
    replayedAt: { type: Date, default: null },
    replayReason: { type: String, default: null },
    nextAttemptAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    publishedAt: { type: Date, default: null },
    streamId: { type: String, default: null },
  },
  options,
);
OutboxSchema.index({ status: 1, nextAttemptAt: 1 });
OutboxSchema.index({ status: 1, claimedUntil: 1 });

// TTL로 제거하지 않는다. 보존된 Stream 재생에서도 같은 eventId를 다시 적용하지 않는다.
export const ModerationReceiptSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    postId: { type: String, required: true },
    eventType: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    correlationId: { type: String, required: true },
    processedAt: { type: Date, required: true },
  },
  options,
);
