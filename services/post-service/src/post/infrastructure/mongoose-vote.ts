import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { LocationAuthorization } from '../application/ports.js';
import { LOCATION_AUTHORIZATION } from '../application/ports.js';
import { Inject } from '@nestjs/common';
import { PostNotFoundError } from '../domain/post.js';
import {
  VoteUnavailableError,
  type VoteCandidate,
  type VoteState,
} from '../application/vote.js';

@Injectable()
export class MongooseVote {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
    @InjectModel('VoteSelection') private readonly selections: Model<any>,
    @Inject(LOCATION_AUTHORIZATION)
    private readonly authorization: LocationAuthorization,
  ) {}

  private async transaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connection.transaction(work);
      } catch (error) {
        const mongo = error as {
          code?: number;
          hasErrorLabel?: (label: string) => boolean;
        };
        // 두 첫 투표가 동시에 유일 인덱스를 만들 때 새 스냅샷에서 현재 선택을 다시 읽는다.
        if (
          attempt < 4 &&
          (mongo.code === 11000 ||
            mongo.hasErrorLabel?.('TransientTransactionError'))
        )
          continue;
        throw error;
      }
    }
  }

  async selectDue(postId: string, now = new Date()): Promise<void> {
    await this.transaction(async (session) => {
      const post = await this.posts.findOne({ postId }).session(session).lean();
      if (
        !post ||
        post.vote?.status !== 'PENDING' ||
        !post.voteAt ||
        post.voteAt > now
      )
        return;
      if (post.status !== 'ACTIVE' || (post.expiresAt && post.expiresAt <= now))
        return;
      const comments = await this.comments
        .find({ postId, status: 'ACTIVE' })
        .session(session)
        .lean();
      const ranked = comments
        .sort(
          (a, b) =>
            Number(b.reactionCounts?.HELPFUL ?? 0) +
              Number(b.reactionCounts?.AGREE ?? 0) -
              (Number(a.reactionCounts?.HELPFUL ?? 0) +
                Number(a.reactionCounts?.AGREE ?? 0)) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.commentId.localeCompare(b.commentId),
        )
        .slice(0, 2);
      if (ranked.length < 2) {
        await this.posts.updateOne(
          { postId, 'vote.status': 'PENDING' },
          { $set: { vote: { ...post.vote, status: 'NONE', closedAt: now } } },
          { session },
        );
        return;
      }
      // 댓글 삭제·공감 변경과 후보 스냅샷 저장의 순서를 확정한다.
      for (const comment of ranked) {
        const fence = await this.comments.updateOne(
          { postId, commentId: comment.commentId, status: 'ACTIVE' },
          { $inc: { voteSelectionFence: 1 } },
          { session },
        );
        if (fence.matchedCount !== 1)
          throw new Error('Candidate changed during selection');
      }
      const candidates: VoteCandidate[] = ranked.map((comment) => ({
        commentId: comment.commentId,
        content: comment.content,
        scoreAtSelection:
          Number(comment.reactionCounts?.HELPFUL ?? 0) +
          Number(comment.reactionCounts?.AGREE ?? 0),
        votes: 0,
      }));
      await this.posts.updateOne(
        { postId, 'vote.status': 'PENDING' },
        {
          $set: {
            vote: {
              status: 'OPEN',
              candidates,
              selectedAt: now,
              closedAt: null,
              winner: null,
            },
          },
        },
        { session },
      );
    });
  }

  async read(postId: string, userId?: number) {
    const post = await this.posts
      .findOne({ postId }, 'postId vote -_id')
      .lean();
    if (!post) throw new PostNotFoundError('Post not found');
    const selection = userId
      ? await this.selections.findOne({ postId, userId }).lean()
      : null;
    return this.view(post.vote ?? null, selection?.commentId ?? null);
  }

  private view(vote: VoteState | null, mySelection: string | null) {
    return {
      status: vote?.status ?? 'NONE',
      candidates: vote?.candidates ?? [],
      selectedAt: vote?.selectedAt ?? null,
      closedAt: vote?.closedAt ?? null,
      winner: vote?.winner ?? null,
      mySelection,
    };
  }

  async choose(postId: string, userId: number, commentId: string) {
    const post = await this.posts.findOne({ postId }).lean();
    if (!post) throw new PostNotFoundError('Post not found');
    if (
      post.status !== 'ACTIVE' ||
      (post.expiresAt && post.expiresAt <= new Date()) ||
      post.vote?.status !== 'OPEN' ||
      !post.vote.candidates.some(
        (candidate: VoteCandidate) => candidate.commentId === commentId,
      )
    )
      throw new VoteUnavailableError(
        'Vote is not open or comment is not a candidate',
      );
    await this.authorization.assertCanJoin(
      userId,
      postId,
      post.locationSnapshot.latitude,
      post.locationSnapshot.longitude,
      post.radiusM,
    );
    return this.change(postId, userId, commentId);
  }

  async cancel(postId: string, userId: number) {
    return this.change(postId, userId, null);
  }

  private async change(
    postId: string,
    userId: number,
    commentId: string | null,
  ) {
    return this.transaction(async (session) => {
      const post = await this.posts.findOne({ postId }).session(session).lean();
      if (!post) throw new PostNotFoundError('Post not found');
      const vote = post.vote as VoteState | null;
      if (
        post.status !== 'ACTIVE' ||
        (post.expiresAt && post.expiresAt <= new Date()) ||
        vote?.status !== 'OPEN'
      )
        throw new VoteUnavailableError('Vote is not open');
      if (
        commentId &&
        !vote.candidates.some((candidate) => candidate.commentId === commentId)
      )
        throw new VoteUnavailableError('Comment is not a candidate');
      const previous = await this.selections
        .findOne({ postId, userId })
        .session(session)
        .lean();
      const oldId = previous?.commentId ?? null;
      if (oldId === commentId) {
        await this.posts.updateOne(
          { postId, 'vote.status': 'OPEN' },
          { $inc: { voteRevision: 1 } },
          { session },
        );
        return this.view(vote, commentId);
      }
      const candidates = vote.candidates.map((candidate) => ({
        ...candidate,
        votes:
          candidate.votes +
          (candidate.commentId === commentId ? 1 : 0) -
          (candidate.commentId === oldId ? 1 : 0),
      }));
      if (previous)
        await this.selections.updateOne(
          { postId, userId },
          { $set: { commentId, updatedAt: new Date() } },
          { session },
        );
      else if (commentId)
        await this.selections.create(
          [{ postId, userId, commentId, updatedAt: new Date() }],
          { session },
        );
      await this.posts.updateOne(
        { postId, 'vote.status': 'OPEN' },
        { $set: { vote: { ...vote, candidates } }, $inc: { voteRevision: 1 } },
        { session },
      );
      return this.view({ ...vote, candidates }, commentId);
    });
  }
}
