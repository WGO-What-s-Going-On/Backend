import { Inject, ServiceUnavailableException } from '@nestjs/common';
import {
  LOCATION_AUTHORIZATION,
  type LocationAuthorization,
} from './application/ports.js';
import { UserProfiles } from './infrastructure/user-profiles.js';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Injectable,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Types, type Model } from 'mongoose';
import { GatewayAuthGuard } from '../gateway-auth.js';
import { userId } from './presentation/post.input.js';
export function activityLevel(
  participation: number,
  agreeReceived: number,
  picks: number,
) {
  const score = picks * 10;
  const level =
    participation < 10 ? 0 : agreeReceived < 10 ? 1 : score < 50 ? 2 : 3;
  return {
    participation,
    agreeReceived,
    picks,
    score,
    level: level + 1,
    title: ['소식통', '리포터', '특파원', '천리안'][level],
  };
}
@Injectable()
export class Activities {
  constructor(
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
    @InjectModel('Reaction') private readonly reactions: Model<any>,
    @InjectModel('CommentReaction')
    private readonly commentReactions: Model<any>,
    @InjectModel('VoteSelection') private readonly votes: Model<any>,
    private readonly profiles: UserProfiles,
  ) {}
  async ranking(actor: number, regionCode: unknown) {
    if (typeof regionCode !== 'string' || !/^[0-9]{10}$/.test(regionCode))
      throw new BadRequestException(
        '10-digit administrative regionCode required',
      );
    if (process.env.POST_REGION_ENABLED !== 'true')
      throw new ServiceUnavailableException('Region ranking is not configured');
    const winnerPipeline = [
      {
        $match: {
          'vote.status': 'CLOSED',
          'vote.winner': { $ne: null },
          status: { $ne: 'DELETED' },
        },
      },
      {
        $lookup: {
          from: 'post_comments',
          localField: 'vote.winner.commentId',
          foreignField: 'commentId',
          as: 'winnerComment',
        },
      },
      { $unwind: '$winnerComment' },
      { $match: { 'winnerComment.status': 'ACTIVE' } },
    ];
    const local = await this.posts
      .aggregate([
        { $match: { 'region.code': regionCode } },
        ...winnerPipeline,
        { $group: { _id: '$winnerComment.authorId', picks: { $sum: 1 } } },
        { $limit: 1001 },
      ])
      .option({ maxTimeMS: 2000 });
    if (local.length > 1000)
      throw new ServiceUnavailableException(
        'Ranking candidate budget exceeded',
      );
    const ids = local.map((row) => row._id);
    const count = (model: Model<any>, field: string, filter: object) =>
      model
        .aggregate([
          { $match: { [field]: { $in: ids }, ...filter } },
          { $group: { _id: `$${field}`, total: { $sum: 1 } } },
        ])
        .option({ maxTimeMS: 2000 });
    const [posts, comments, reactions, commentReactions, votes, agree, picks] =
      await Promise.all([
        count(this.posts, 'authorId', { status: { $ne: 'DELETED' } }),
        count(this.comments, 'authorId', { status: 'ACTIVE' }),
        count(this.reactions, 'userId', { removedAt: null }),
        count(this.commentReactions, 'userId', { removedAt: null }),
        count(this.votes, 'userId', { commentId: { $ne: null } }),
        this.comments
          .aggregate([
            { $match: { authorId: { $in: ids }, status: 'ACTIVE' } },
            {
              $group: {
                _id: '$authorId',
                total: { $sum: '$reactionCounts.AGREE' },
              },
            },
          ])
          .option({ maxTimeMS: 2000 }),
        this.posts
          .aggregate([
            ...winnerPipeline,
            { $match: { 'winnerComment.authorId': { $in: ids } } },
            { $group: { _id: '$winnerComment.authorId', total: { $sum: 1 } } },
          ])
          .option({ maxTimeMS: 2000 }),
      ]);
    const total = (rows: any[], id: number) =>
      rows.find((row) => row._id === id)?.total ?? 0;
    const ranked = local
      .filter(
        (row) =>
          activityLevel(
            [posts, comments, reactions, commentReactions, votes].reduce(
              (sum, rows) => sum + total(rows, row._id),
              0,
            ),
            total(agree, row._id),
            total(picks, row._id),
          ).level === 4,
      )
      .sort((a, b) => b.picks - a.picks || a._id - b._id);
    const page = ranked.slice(0, 100);
    const names = await this.profiles.names(page.map((row) => row._id));
    const myIndex = ranked.findIndex((row) => row._id === actor);
    return {
      regionCode,
      items: page.map((row, index) => ({
        rank: index + 1,
        userId: row._id,
        authorNickname: names.get(row._id) ?? null,
        picks: row.picks,
        score: row.picks * 10,
      })),
      myRank: myIndex < 0 ? null : myIndex + 1,
      myScore: myIndex < 0 ? 0 : ranked[myIndex]!.picks * 10,
    };
  }
  async stats(actor: number) {
    const [posts, comments, reactions, commentReactions, votes, agree, picks] =
      await Promise.all([
        this.posts
          .countDocuments({ authorId: actor, status: { $ne: 'DELETED' } })
          .maxTimeMS(2000),
        this.comments
          .countDocuments({ authorId: actor, status: 'ACTIVE' })
          .maxTimeMS(2000),
        this.reactions
          .countDocuments({ userId: actor, removedAt: null })
          .maxTimeMS(2000),
        this.commentReactions
          .countDocuments({ userId: actor, removedAt: null })
          .maxTimeMS(2000),
        this.votes
          .countDocuments({ userId: actor, commentId: { $ne: null } })
          .maxTimeMS(2000),
        this.comments
          .aggregate([
            { $match: { authorId: actor, status: 'ACTIVE' } },
            { $group: { _id: null, total: { $sum: '$reactionCounts.AGREE' } } },
          ])
          .option({ maxTimeMS: 2000 }),
        this.posts
          .aggregate([
            {
              $match: {
                'vote.status': 'CLOSED',
                'vote.winner': { $ne: null },
                status: { $ne: 'DELETED' },
              },
            },
            {
              $lookup: {
                from: 'post_comments',
                localField: 'vote.winner.commentId',
                foreignField: 'commentId',
                as: 'winnerComment',
              },
            },
            {
              $match: {
                'winnerComment.authorId': actor,
                'winnerComment.status': 'ACTIVE',
              },
            },
            { $count: 'total' },
          ])
          .option({ maxTimeMS: 2000 }),
      ]);
    return activityLevel(
      posts + comments + reactions + commentReactions + votes,
      agree[0]?.total ?? 0,
      picks[0]?.total ?? 0,
    );
  }
  async list(actor: number, cursor?: string) {
    let before: { date: Date; id: Types.ObjectId } | undefined;
    if (cursor) {
      try {
        const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !/^[a-f0-9]{24}$/.test(raw.id) ||
          !Number.isFinite(Date.parse(raw.date))
        )
          throw new Error();
        before = { date: new Date(raw.date), id: new Types.ObjectId(raw.id) };
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
    }
    const sources = [
      {
        model: this.posts,
        kind: 'POST',
        filter: { authorId: actor, status: { $ne: 'DELETED' } },
        time: 'createdAt',
      },
      {
        model: this.comments,
        kind: 'COMMENT',
        filter: { authorId: actor, status: 'ACTIVE' },
        time: 'createdAt',
      },
      {
        model: this.reactions,
        kind: 'REACTION',
        filter: { userId: actor, removedAt: null },
        time: 'createdAt',
      },
      {
        model: this.commentReactions,
        kind: 'COMMENT_REACTION',
        filter: { userId: actor, removedAt: null },
        time: 'createdAt',
      },
      {
        model: this.votes,
        kind: 'VOTE',
        filter: { userId: actor, commentId: { $ne: null } },
        time: 'updatedAt',
      },
    ];
    const pages = await Promise.all(
      sources.map(async (source) => {
        const filter = before
          ? {
              $or: [
                { [source.time]: { $lt: before.date } },
                { [source.time]: before.date, _id: { $lt: before.id } },
              ],
            }
          : {};
        const rows = await source.model
          .find(
            { ...source.filter, ...filter },
            `postId commentId ${source.time} closedAt`,
          )
          .sort({ [source.time]: -1, _id: -1 })
          .limit(21)
          .maxTimeMS(2000)
          .lean();
        return rows.map((row) => ({
          kind: source.kind,
          postId: row.postId,
          commentId: row.commentId ?? null,
          createdAt: row[source.time] as Date,
          id: String(row._id),
          closedAt: row.closedAt ?? null,
        }));
      }),
    );
    const rows = pages
      .flat()
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
    const selected = rows.slice(0, 20);
    const last = selected.at(-1);
    return {
      items: selected.map(({ id, ...item }) => item),
      nextCursor:
        rows.length > 20 && last
          ? Buffer.from(
              JSON.stringify({
                date: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }
}
@Controller('api/v1/posts/me')
@ApiTags('Activity')
@UseGuards(GatewayAuthGuard)
export class ActivityController {
  constructor(
    private readonly activities: Activities,
    @Inject(LOCATION_AUTHORIZATION)
    private readonly location: LocationAuthorization,
  ) {}
  @Get('ranking')
  @ApiOperation({
    summary: 'Administrative dong ranking',
    description:
      'Top 100 globally qualified 천리안 users, ordered by representative points earned in this district then user ID. Includes myRank.',
  })
  ranking(
    @Headers('x-user-id') header: string,
    @Query('regionCode') region: unknown,
  ) {
    return this.activities.ranking(userId(header), region);
  }
  @Get('region')
  @ApiOperation({ summary: 'Resolve coordinates to an administrative dong' })
  region(@Query('latitude') lat: unknown, @Query('longitude') lon: unknown) {
    if (
      typeof lat !== 'string' ||
      typeof lon !== 'string' ||
      !lat.trim() ||
      !lon.trim() ||
      !Number.isFinite(Number(lat)) ||
      !Number.isFinite(Number(lon)) ||
      Math.abs(Number(lat)) > 90 ||
      Math.abs(Number(lon)) > 180
    )
      throw new BadRequestException('Invalid coordinates');
    if (!this.location.resolveRegion)
      throw new ServiceUnavailableException('Region resolution unavailable');
    return this.location.resolveRegion(Number(lat), Number(lon));
  }
  @Get('activity')
  @ApiOperation({
    summary: 'Recent own activity',
    description: '20 items per page; cursor from nextCursor.',
  })
  list(@Headers('x-user-id') header: string, @Query('cursor') cursor?: string) {
    return this.activities.list(userId(header), cursor);
  }
  @Get('level')
  @ApiOperation({
    summary: 'Activity points and title',
    description:
      'Participation 10, received AGREE 10, representative score 50; 10 points per winning comment.',
  })
  stats(@Headers('x-user-id') header: string) {
    return this.activities.stats(userId(header));
  }
}
