import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { UserProfiles } from './user-profiles.js';
import type { PostRecord, CommentRecord } from '../domain/post.js';
@Injectable()
export class FrontendViews {
  constructor(
    @InjectModel('Reaction') private readonly reactions: Model<any>,
    @InjectModel('CommentReaction')
    private readonly commentReactions: Model<any>,
    private readonly profiles: UserProfiles,
  ) {}
  async posts<T extends PostRecord>(posts: T[], actor?: number) {
    const ids = posts.map((p) => p.postId);
    const [names, counts, mine] = await Promise.all([
      this.profiles.names(
        posts.filter((p) => !p.anonymous).map((p) => p.authorId),
      ),
      this.reactions.aggregate([
        { $match: { postId: { $in: ids }, removedAt: null } },
        {
          $group: {
            _id: { postId: '$postId', type: '$type' },
            count: { $sum: 1 },
          },
        },
      ]),
      actor
        ? this.reactions
            .find({ postId: { $in: ids }, userId: actor, removedAt: null })
            .lean()
        : [],
    ]);
    return posts.map((post) => {
      const reactionCounts: Record<string, number> = {
        CURIOUS: 0,
        STILL_HAPPENING: 0,
        HELPFUL: 0,
        ENDED: 0,
      };
      for (const row of counts)
        if (
          row._id.postId === post.postId &&
          Object.hasOwn(reactionCounts, row._id.type)
        )
          reactionCounts[row._id.type] = row.count;
      return {
        ...post,
        authorId:
          post.anonymous && post.authorId !== actor ? null : post.authorId,
        anonymous: post.anonymous ?? false,
        authorNickname: post.anonymous
          ? null
          : (names.get(post.authorId) ?? null),
        reactionCounts,
        myReaction: mine.find((r) => r.postId === post.postId)?.type ?? null,
      };
    });
  }
  async comments<T extends CommentRecord>(comments: T[], actor?: number) {
    const [names, mine] = await Promise.all([
      this.profiles.names(comments.map((c) => c.authorId)),
      actor
        ? this.commentReactions
            .find({
              commentId: { $in: comments.map((c) => c.commentId) },
              userId: actor,
              removedAt: null,
            })
            .lean()
        : [],
    ]);
    return comments.map((c) => ({
      ...c,
      authorNickname: names.get(c.authorId) ?? null,
      myReaction: mine.find((r) => r.commentId === c.commentId)?.type ?? null,
    }));
  }
}
