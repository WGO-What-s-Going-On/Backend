import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Connection, Model } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';

type Body = Record<string, unknown>;

function object(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('JSON object required');
  return value as Body;
}

function string(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new BadRequestException(`${name} is required (max ${max} characters)`);
  return value.trim();
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new BadRequestException(`${name} must be between ${min} and ${max}`);
  return value;
}

function fields(body: Body, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestException('Unknown field');
}

function postId(value: string): string {
  if (!/^post_[0-9a-f-]{36}$/.test(value)) throw new BadRequestException('Invalid postId');
  return value;
}

@Injectable()
export class PostService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
    @InjectModel('Reaction') private readonly reactions: Model<any>,
    @InjectModel('Participant') private readonly participants: Model<any>,
    @InjectModel('Outbox') private readonly outbox: Model<any>,
  ) {}

  userId(header: string | undefined): number {
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Authentication integration unavailable');
    if (!header || !/^[1-9]\d*$/.test(header) || !Number.isSafeInteger(Number(header))) throw new ForbiddenException('Valid X-User-Id required');
    return Number(header);
  }

  private async emit(session: any, aggregateId: string, eventType: string, payload: Body, now: Date): Promise<void> {
    await this.outbox.create([{
      eventId: `evt_${randomUUID()}`, aggregateId, eventType, schemaVersion: 1,
      producer: 'post-service', correlationId: `req_${randomUUID()}`,
      occurredAt: now, payload, status: 'PENDING', claimedBy: null, claimedUntil: null,
      attemptCount: 0, nextAttemptAt: now, createdAt: now, publishedAt: null, streamId: null,
    }], { session });
  }

  private async active(id: string, session: any): Promise<void> {
    const post = await this.posts.findOne({ postId: postId(id) }).session(session).lean();
    if (!post) throw new NotFoundException('Post not found');
    if (post.status !== 'ACTIVE') throw new ForbiddenException('Post is not active');
  }

  private async increment(id: string, field: 'commentCount' | 'reactionCount' | 'participantCount', session: any, now: Date): Promise<void> {
    const result = await this.posts.updateOne({ postId: id, status: 'ACTIVE' }, { $inc: { [`counters.${field}`]: 1 }, $set: { updatedAt: now } }, { session });
    if (result.matchedCount !== 1) throw new ForbiddenException('Post is not active');
  }

  async createPost(raw: unknown, userId: number) {
    const body = object(raw);
    fields(body, ['title', 'content', 'category', 'latitude', 'longitude', 'radiusM']);
    const title = string(body.title, 'title', 120);
    const content = string(body.content, 'content', 5000);
    const category = string(body.category, 'category', 40);
    if (!/^[A-Z][A-Z_]*$/.test(category)) throw new BadRequestException('Invalid category');
    const latitude = number(body.latitude, 'latitude', -90, 90);
    const longitude = number(body.longitude, 'longitude', -180, 180);
    const radiusM = number(body.radiusM, 'radiusM', 1, 10000);
    const now = new Date();
    const post = { postId: `post_${randomUUID()}`, authorId: userId, category, title, content, status: 'ACTIVE', locationSnapshot: { latitude, longitude }, radiusM, counters: { viewCount: 0, commentCount: 0, reactionCount: 0, participantCount: 0 }, createdAt: now, updatedAt: now, expiresAt: null };
    await this.connection.transaction(async (session) => {
      await this.posts.create([post], { session });
      await this.emit(session, post.postId, 'PostCreated', { post: { postId: post.postId, authorId: userId, latitude, longitude, radiusM, category, expiresAt: null } }, now);
    });
    return post;
  }

  async createComment(id: string, raw: unknown, userId: number) {
    const body = object(raw);
    fields(body, ['content']);
    const content = string(body.content, 'content', 2000);
    const now = new Date();
    const comment = { commentId: `comment_${randomUUID()}`, postId: postId(id), authorId: userId, content, status: 'ACTIVE', createdAt: now, updatedAt: null };
    await this.connection.transaction(async (session) => {
      await this.active(id, session);
      await this.comments.create([comment], { session });
      await this.increment(id, 'commentCount', session, now);
      await this.emit(session, id, 'PostCommentCreated', { comment }, now);
    });
    return comment;
  }

  async createReaction(id: string, raw: unknown, userId: number) {
    const body = object(raw);
    fields(body, ['type']);
    if (body.type !== 'LIKE') throw new BadRequestException('Only LIKE is supported');
    const now = new Date();
    const reaction = { postId: postId(id), userId, type: 'LIKE', createdAt: now };
    try {
      const result = await this.connection.transaction(async (session) => {
        await this.active(id, session);
        const existing = await this.reactions.findOne({ postId: id, userId, type: 'LIKE' }).session(session).lean();
        if (existing) return existing;
        await this.reactions.create([reaction], { session });
        await this.increment(id, 'reactionCount', session, now);
        await this.emit(session, id, 'PostReactionCreated', { reaction }, now);
        return reaction;
      });
      return result;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.reactions.findOne({ postId: id, userId, type: 'LIKE' }).lean();
        if (existing) return existing;
      }
      throw error;
    }
  }

  async join(id: string, raw: unknown, userId: number) {
    const body = object(raw);
    fields(body, []);
    postId(id);
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Map participation authorization unavailable');
    const now = new Date();
    const participant = { postId: id, userId, joinedAt: now, lastSeenAt: now, leftAt: null };
    try {
      return await this.connection.transaction(async (session) => {
        await this.active(id, session);
        const existing = await this.participants.findOne({ postId: id, userId }).session(session).lean();
        if (existing && existing.leftAt === null) return existing;
        if (existing) {
          const updated = await this.participants.findOneAndUpdate({ postId: id, userId, leftAt: { $ne: null } }, { $set: { joinedAt: now, lastSeenAt: now, leftAt: null } }, { session, new: true }).lean();
          if (!updated) return this.participants.findOne({ postId: id, userId }).session(session).lean();
        } else {
          await this.participants.create([participant], { session });
        }
        await this.increment(id, 'participantCount', session, now);
        await this.emit(session, id, 'PostParticipantJoined', { participant }, now);
        return participant;
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.participants.findOne({ postId: id, userId, leftAt: null }).lean();
        if (existing) return existing;
      }
      throw error;
    }
  }
}
