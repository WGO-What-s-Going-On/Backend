import { Schema } from 'mongoose';

const options = { versionKey: false, strict: true } as const;

export const PostSchema = new Schema({
  postId: { type: String, required: true, unique: true },
  authorId: { type: Number, required: true },
  category: { type: String, required: true },
  title: { type: String, required: true },
  content: { type: String, required: true },
  status: { type: String, required: true },
  locationSnapshot: { latitude: Number, longitude: Number },
  radiusM: { type: Number, required: true },
  counters: { viewCount: Number, commentCount: Number, reactionCount: Number, participantCount: Number },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  expiresAt: { type: Date, default: null },
}, options);
PostSchema.index({ authorId: 1, createdAt: -1 });
PostSchema.index({ status: 1, expiresAt: 1 });
PostSchema.index({ category: 1, createdAt: -1 });

export const CommentSchema = new Schema({
  commentId: { type: String, required: true, unique: true },
  postId: { type: String, required: true },
  authorId: { type: Number, required: true },
  mutationId: { type: String },
  content: { type: String, required: true },
  status: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, default: null },
}, options);
CommentSchema.index({ postId: 1, createdAt: -1, _id: -1 });
// 기존 HTTP 댓글에는 mutationId가 없으므로 값이 있는 WS 요청에만 유일성을 적용한다.
CommentSchema.index({ postId: 1, authorId: 1, mutationId: 1 }, { unique: true, partialFilterExpression: { mutationId: { $type: 'string' } } });

export const ReactionSchema = new Schema({
  postId: { type: String, required: true },
  userId: { type: Number, required: true },
  type: { type: String, required: true },
  createdAt: { type: Date, required: true },
}, options);
ReactionSchema.index({ postId: 1, userId: 1, type: 1 }, { unique: true });

export const ParticipantSchema = new Schema({
  postId: { type: String, required: true },
  userId: { type: Number, required: true },
  joinedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  leftAt: { type: Date, default: null },
}, options);
ParticipantSchema.index({ postId: 1, userId: 1 }, { unique: true });
ParticipantSchema.index({ postId: 1, joinedAt: -1 });

export const OutboxSchema = new Schema({
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
  nextAttemptAt: { type: Date, required: true },
  createdAt: { type: Date, required: true },
  publishedAt: { type: Date, default: null },
  streamId: { type: String, default: null },
}, options);
OutboxSchema.index({ status: 1, nextAttemptAt: 1 });
OutboxSchema.index({ status: 1, claimedUntil: 1 });
