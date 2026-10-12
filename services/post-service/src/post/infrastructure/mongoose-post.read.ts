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
    @InjectModel('Counter') private readonly counters: Model<any>,
  ) {}

  async findDetail(postId: string) {
    const post = await this.posts.findOne({ postId }, '-_id -__v').lean();
    if (!post) return null;
    const increments = await this.counters
      .find({ postId }, 'metric count -_id')
      .lean();
    const count = (metric: string) =>
      (post.counters?.[metric] ?? 0) +
      increments.reduce(
        (total, row) => total + (row.metric === metric ? row.count : 0),
        0,
      );
    return {
      postId: post.postId,
      authorId: post.authorId,
      category: post.category,
      title: post.title,
      content: post.content,
      status: post.status,
      locationSnapshot: {
        latitude: post.locationSnapshot.latitude,
        longitude: post.locationSnapshot.longitude,
      },
      radiusM: post.radiusM,
      counters: {
        viewCount: count('viewCount'),
        commentCount: count('commentCount'),
        reactionCount: count('reactionCount'),
        participantCount: count('participantCount'),
      },
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      expiresAt: post.expiresAt,
    };
  }

  async findComments(
    postId: string,
    cursor: CommentCursor | null,
    limit: number,
  ) {
    const post = await this.posts
      .findOne({ postId }, 'bucketCount -_id')
      .lean();
    const bucketCount = post?.bucketCount ?? 1;
    const cursorFilter: Record<string, unknown> = {};
    // 작성 시각이 같은 댓글은 _id로 순서를 고정해 페이지 사이의 중복·누락을 막는다.
    if (cursor)
      cursorFilter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        {
          createdAt: cursor.createdAt,
          _id: { $lt: new Types.ObjectId(cursor.id) },
        },
      ];
    // bucket 0의 조건에는 이전 스키마의 bucketId 없는 댓글도 포함한다.
    const rowsByBucket = await Promise.all(
      Array.from({ length: bucketCount }, (_, bucketId) => {
        const filter = {
          postId,
          status: 'ACTIVE',
          bucketId: bucketId === 0 ? { $in: [0, null] } : bucketId,
          ...cursorFilter,
        };
        return this.comments
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit)
          .lean();
      }),
    );
    const rows = rowsByBucket
      .flat()
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          String(b._id).localeCompare(String(a._id)),
      )
      .slice(0, limit);
    return rows.map((row) => ({
      id: String(row._id),
      comment: {
        commentId: row.commentId,
        postId: row.postId,
        authorId: row.authorId,
        content: row.content,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    }));
  }

  async findActiveBatch(postIds: string[]) {
    const rows = await this.posts
      .find(
        {
          postId: { $in: postIds },
          status: 'ACTIVE',
          $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
        },
        'postId title category status createdAt -_id',
      )
      .lean();
    return rows.map((row) => ({
      postId: row.postId,
      title: row.title,
      category: row.category,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async findMeta(postId: string) {
    const post = await this.posts
      .findOne(
        { postId },
        'postId status category locationSnapshot radiusM expiresAt -_id',
      )
      .lean();
    return post
      ? {
          postId: post.postId,
          status: post.status,
          category: post.category,
          locationSnapshot: {
            latitude: post.locationSnapshot.latitude,
            longitude: post.locationSnapshot.longitude,
          },
          radiusM: post.radiusM,
          expiresAt: post.expiresAt,
        }
      : null;
  }

  async findStatus(postId: string) {
    const post = await this.posts
      .findOne({ postId }, 'postId status expiresAt -_id')
      .lean();
    return post
      ? { postId: post.postId, status: post.status, expiresAt: post.expiresAt }
      : null;
  }
}
