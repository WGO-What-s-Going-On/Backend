import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Injectable,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Model } from 'mongoose';
import { GatewayAuthGuard } from '../gateway-auth.js';
import { GrpcNearbyPosts } from './semantic/grpc-candidates.js';
import { FrontendViews } from './infrastructure/frontend-views.js';
import { MediaService } from './media/media.service.js';
import { userId } from './presentation/post.input.js';
import { NearbyPageResponse } from './presentation/post.openapi.js';

export function nearbyInput(query: Record<string, unknown>) {
  if (
    Object.keys(query).some(
      (k) =>
        ![
          'latitude',
          'longitude',
          'radiusM',
          'limit',
          'cursor',
          'sort',
          'category',
          'q',
        ].includes(k),
    )
  )
    throw new BadRequestException('Unknown query');
  const number = (name: string, fallback?: number) => {
    const value = query[name];
    if (value === undefined && fallback !== undefined) return fallback;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      !Number.isFinite(Number(value))
    )
      throw new BadRequestException(`Invalid ${name}`);
    return Number(value);
  };
  const latitude = number('latitude'),
    longitude = number('longitude'),
    radiusM = number('radiusM', 150),
    limit = number('limit', 20);
  if (
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    ![150, 250, 350].includes(radiusM) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new BadRequestException('Invalid nearby range');
  const sort = query.sort ?? 'distance';
  if (sort !== 'distance' && sort !== 'latest')
    throw new BadRequestException('Invalid sort');
  const category = query.category;
  if (
    category !== undefined &&
    (typeof category !== 'string' || !/^[A-Z][A-Z_]{0,39}$/.test(category))
  )
    throw new BadRequestException('Invalid category');
  const q = query.q;
  if (q !== undefined && (typeof q !== 'string' || !q.trim() || q.length > 100))
    throw new BadRequestException('Invalid search');
  const scope = JSON.stringify([
    latitude,
    longitude,
    radiusM,
    sort,
    category ?? null,
    q ?? null,
  ]);
  let after: { key: number; id: string } | null = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 2048)
        throw new Error();
      const parsed = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString(),
      );
      if (
        parsed.scope !== scope ||
        !Number.isFinite(parsed.key) ||
        typeof parsed.id !== 'string'
      )
        throw new Error();
      after = { key: parsed.key, id: parsed.id };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }
  return {
    latitude,
    longitude,
    radiusM: radiusM as 150 | 250 | 350,
    limit,
    sort,
    category,
    q,
    scope,
    after,
  };
}
export function distanceM(a: number, b: number, c: number, d: number) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((c - a) * rad) / 2) ** 2 +
    Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
@Injectable()
export class NearbyPosts {
  constructor(
    private readonly map: GrpcNearbyPosts,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Counter') private readonly counters: Model<any>,
    private readonly views: FrontendViews,
    private readonly media: MediaService,
  ) {}
  async list(raw: Record<string, unknown>, actor: number) {
    const input = nearbyInput(raw);
    const ids = new Set<string>();
    let cursor: string | undefined;
    const deadline = Date.now() + 4000;
    // Latest sorting and category filtering require the complete bounded candidate set.
    // Return an explicit failure instead of silently truncating a dense area's results.
    do {
      if (Date.now() > deadline)
        throw new ServiceUnavailableException('Nearby search budget exceeded');
      const page = await this.map
        .page({
          latitude: input.latitude,
          longitude: input.longitude,
          radiusM: input.radiusM,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        .catch(() => {
          throw new ServiceUnavailableException('Map search unavailable');
        });
      page.items.forEach((p) => ids.add(p.postId));
      if (ids.size > 1000 || (page.nextCursor && page.nextCursor === cursor))
        throw new ServiceUnavailableException('Nearby search budget exceeded');
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const now = new Date();
    const rows = await this.posts
      .find(
        {
          postId: { $in: [...ids] },
          status: 'ACTIVE',
          closedAt: null,
          $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
          ...(input.category ? { category: input.category } : {}),
        },
        'postId authorId anonymous title content category status locationSnapshot radiusM counters mediaIds createdAt updatedAt expiresAt closedAt -_id',
      )
      .maxTimeMS(2000)
      .lean();
    const ordered = rows
      .map((post) => ({
        ...post,
        distanceM: distanceM(
          input.latitude,
          input.longitude,
          post.locationSnapshot.latitude,
          post.locationSnapshot.longitude,
        ),
      }))
      .filter(
        (p) =>
          p.distanceM <= input.radiusM &&
          (!input.q ||
            `${p.title}\n${p.content}`
              .toLocaleLowerCase()
              .includes(String(input.q).toLocaleLowerCase())),
      )
      .map((p) => ({
        post: p,
        key: input.sort === 'latest' ? -p.createdAt.getTime() : p.distanceM,
      }))
      .sort(
        (a, b) => a.key - b.key || a.post.postId.localeCompare(b.post.postId),
      )
      .filter(
        (p) =>
          !input.after ||
          p.key > input.after.key ||
          (p.key === input.after.key && p.post.postId > input.after.id),
      );
    const selected = ordered.slice(0, input.limit);
    const increments = await this.counters
      .find(
        { postId: { $in: selected.map((p) => p.post.postId) } },
        'postId metric count -_id',
      )
      .maxTimeMS(2000)
      .lean();
    for (const { post } of selected) {
      post.counters = { ...post.counters };
      for (const row of increments)
        if (
          row.postId === post.postId &&
          Object.hasOwn(post.counters, row.metric)
        )
          post.counters[row.metric] += row.count;
    }
    const enriched = await this.views.posts(
      selected.map((p) => p.post),
      actor,
    );
    const media = await this.media.forTargets(enriched);
    const last = selected.at(-1);
    return {
      posts: enriched.map((p, i) => ({ ...p, media: media[i] ?? [] })),
      nextCursor:
        ordered.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                scope: input.scope,
                key: last.key,
                id: last.post.postId,
              }),
            ).toString('base64url')
          : null,
    };
  }
}
@Controller('api/v1/posts')
@UseGuards(GatewayAuthGuard)
@ApiTags('Posts')
export class NearbyController {
  constructor(private readonly nearby: NearbyPosts) {}
  @Get('categories')
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, label: { type: 'string' } },
      },
    },
  })
  categories() {
    return [
      { code: 'EMERGENCY', label: '긴급 사고' },
      { code: 'HELP', label: '도움 요청' },
      { code: 'NEWS', label: '동네 소식' },
      { code: 'ETC', label: '일상 불편' },
    ];
  }
  @Get('nearby')
  @ApiQuery({ name: 'latitude', type: Number })
  @ApiQuery({ name: 'longitude', type: Number })
  @ApiQuery({ name: 'radiusM', enum: [150, 250, 350], required: false })
  @ApiQuery({ name: 'sort', enum: ['distance', 'latest'], required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: NearbyPageResponse })
  list(
    @Query() query: Record<string, unknown>,
    @Headers('x-user-id') header: string,
  ) {
    return this.nearby.list(query, userId(header));
  }
}
