import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import type { CommentCursor, PostReadQueries } from '../application/ports.js';

@Injectable()
export class MongoosePostRead implements PostReadQueries {
  constructor(
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
  ) {}

  async findDetail(postId: string) {
    const post = await this.posts.findOne({ postId }, '-_id -__v').lean();
    if (!post) return null;
    return {
      postId: post.postId, authorId: post.authorId, category: post.category, title: post.title,
      content: post.content, status: post.status, locationSnapshot: {
        latitude: post.locationSnapshot.latitude, longitude: post.locationSnapshot.longitude,
      }, radiusM: post.radiusM, counters: {
        viewCount: post.counters.viewCount, commentCount: post.counters.commentCount,
        reactionCount: post.counters.reactionCount, participantCount: post.counters.participantCount,
      }, createdAt: post.createdAt, updatedAt: post.updatedAt, expiresAt: post.expiresAt,
    };
  }

  async findComments(postId: string, cursor: CommentCursor | null, limit: number) {
    const filter: Record<string, unknown> = { postId, status: 'ACTIVE' };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
    ];
    const rows = await this.comments.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    return rows.map((row) => ({
      id: String(row._id),
      comment: {
        commentId: row.commentId, postId: row.postId, authorId: row.authorId, content: row.content,
        status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      },
    }));
  }

  async findActiveBatch(postIds: string[]) {
    const rows = await this.posts.find({ postId: { $in: postIds }, status: 'ACTIVE' }, 'postId title category status createdAt -_id').lean();
    return rows.map((row) => ({ postId: row.postId, title: row.title, category: row.category, status: row.status, createdAt: row.createdAt }));
  }

  async findMeta(postId: string) {
    const post = await this.posts.findOne({ postId }, 'postId status category locationSnapshot radiusM expiresAt -_id').lean();
    return post ? {
      postId: post.postId, status: post.status, category: post.category,
      locationSnapshot: { latitude: post.locationSnapshot.latitude, longitude: post.locationSnapshot.longitude },
      radiusM: post.radiusM, expiresAt: post.expiresAt,
    } : null;
  }

  async findStatus(postId: string) {
    const post = await this.posts.findOne({ postId }, 'postId status expiresAt -_id').lean();
    return post ? { postId: post.postId, status: post.status, expiresAt: post.expiresAt } : null;
  }
}
