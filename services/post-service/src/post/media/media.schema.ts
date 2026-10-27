import { Schema } from 'mongoose';
import type { MediaContentType } from './media.policy.js';
export interface MediaRecord {
  mediaId: string;
  ownerId: number;
  objectKey: string;
  uploadKey: string;
  type: 'IMAGE' | 'VIDEO';
  contentType: MediaContentType;
  sizeBytes: number;
  checksum: string;
  status: 'PENDING' | 'READY' | 'ATTACHED' | 'DELETING';
  createdAt: Date;
  expiresAt: Date;
  verifiedAt?: Date;
  attachedAt?: Date;
  postId?: string;
  commentId?: string;
  cleanupAt?: Date;
}
export const MediaSchema = new Schema<MediaRecord>(
  {
    mediaId: { type: String, required: true, unique: true },
    ownerId: { type: Number, required: true },
    objectKey: { type: String, required: true, unique: true },
    uploadKey: { type: String, required: true },
    type: { type: String, enum: ['IMAGE', 'VIDEO'], required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    checksum: { type: String, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'READY', 'ATTACHED', 'DELETING'],
      required: true,
    },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    verifiedAt: Date,
    attachedAt: Date,
    postId: String,
    commentId: String,
    cleanupAt: Date,
  },
  { versionKey: false, strict: true },
);
// TTL로 DB 기록만 지우면 S3 파일이 남으므로 삭제 성공 후 worker가 기록을 지운다.
MediaSchema.index({ status: 1, expiresAt: 1 });
MediaSchema.index({ status: 1, cleanupAt: 1 });
MediaSchema.index({ status: 1, mediaId: 1 });
