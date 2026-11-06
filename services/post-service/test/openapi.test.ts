import { MediaController } from '../src/post/media/media.controller.js';
import { MediaService } from '../src/post/media/media.service.js';
import { POST_STATE_QUERIES } from '../src/post/application/ports.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import {
  Activities,
  ActivityController,
} from '../src/post/activity.controller.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { FindSimilarPosts } from '../src/post/semantic/search.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthController } from '../src/health/health.controller.js';
import {
  CreateComment,
  CreateCommentReaction,
  CreatePost,
  CreateReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import { ReadPosts } from '../src/post/application/queries.js';
import {
  InternalPostController,
  PostController,
} from '../src/post/post.controller.js';
import { configureSwagger } from '../src/swagger.js';

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        MediaController,
        HealthController,
        PostController,
        InternalPostController,
        ActivityController,
      ],
      providers: [
        MediaService,
        POST_STATE_QUERIES,
        PostLifecycle,
        MongooseVote,
        CreatePost,
        CreateComment,
        CreateCommentReaction,
        CreateReaction,
        JoinPost,
        ReadPosts,
        FindSimilarPosts,
        Activities,
        LOCATION_AUTHORIZATION,
      ].map((provide) => ({ provide, useValue: {} })),
    }).compile();
    app = module.createNestApplication();
    configureSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI and documents every HTTP route with request and response schemas', async () => {
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect('Content-Type', /html/);
    const response = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    const document = response.body;
    for (const path of Object.keys(document.paths)) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
        const operation = document.paths[path][method];
        if (!operation) continue;
        for (const requirement of operation.security ?? []) {
          for (const name of Object.keys(requirement)) {
            expect(document.components.securitySchemes).toHaveProperty(name);
          }
        }
      }
    }
    expect(
      document.paths['/api/v1/posts/{postId}/comments/{commentId}'].patch
        .responses['204'],
    ).toBeDefined();
    expect(
      document.paths['/api/v1/posts/similar'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CreatePostBody' });
    expect(
      document.components.schemas.CreatePostBody.properties,
    ).not.toHaveProperty('limit');
    expect(
      document.components.schemas.SimilarPostsResponse.properties.items
        .maxItems,
    ).toBe(3);
    expect(
      document.components.schemas.SimilarPostItem.properties.similarityPercent,
    ).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
    expect(document.components.schemas.SimilarPostItem.required).toContain(
      'similarityPercent',
    );
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v1/posts',
        '/api/v1/posts/me/level',
        '/api/v1/posts/me/ranking',
        '/api/v1/posts/me/activity',
        '/api/v1/posts/me/region',
        '/api/v1/posts/{postId}/closed',
        '/api/v1/posts/similar',
        '/api/v1/posts/media/uploads',
        '/api/v1/posts/media/uploads/{mediaId}',
        '/api/v1/posts/media/uploads/{mediaId}/complete',
        '/api/v1/posts/{postId}/media',
        '/api/v1/posts/{postId}/comments/{commentId}/media',
        '/api/v1/posts/{postId}',
        '/api/v1/posts/{postId}/comments',
        '/api/v1/posts/{postId}/comments/{commentId}',
        '/api/v1/posts/{postId}/comments/{commentId}/reactions',
        '/api/v1/posts/{postId}/comments/{commentId}/reactions/{type}',
        '/api/v1/posts/{postId}/participants',
        '/api/v1/posts/{postId}/reactions',
        '/api/v1/posts/{postId}/reactions/{type}',
        '/api/v1/posts/{postId}/vote',
        '/health/live',
        '/internal/v1/posts/batch-get',
        '/internal/v1/posts/{postId}',
        '/internal/v1/posts/{postId}/comments',
        '/internal/v1/posts/{postId}/participants',
        '/internal/v1/posts/{postId}/meta',
        '/internal/v1/posts/{postId}/status',
      ].sort(),
    );
    expect(
      document.paths['/api/v1/posts'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toBeDefined();
    expect(
      document.paths['/api/v1/posts/{postId}/comments'].get.responses['200']
        .content['application/json'].schema,
    ).toBeDefined();
    expect(
      document.paths['/internal/v1/posts/{postId}/comments'].post.security,
    ).toEqual([{ 'service-jwt': [] }]);
    expect(
      document.components.schemas.InternalCreateCommentBody.properties
        .mutationId,
    ).toMatchObject({ maxLength: 128 });
    expect(
      document.components.schemas.PostResponse.properties.counters,
    ).toBeDefined();
    expect(
      document.components.schemas.CreateReactionBody.properties.type.enum,
    ).toEqual(['CURIOUS', 'STILL_HAPPENING', 'HELPFUL', 'ENDED']);
    expect(
      document.components.schemas.CreateCommentReactionBody.properties.type
        .enum,
    ).toEqual(['HELPFUL', 'AGREE', 'DIFFERENT']);
    expect(
      document.paths['/api/v1/posts/{postId}/reactions'].post.responses['409'],
    ).toBeDefined();
    expect(
      document.paths['/api/v1/posts/{postId}/comments/{commentId}/reactions']
        .post.responses['409'],
    ).toBeDefined();
  });

  it('documents activity response fields, nested items and nullable values', async () => {
    const { body: document } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    for (const [route, name] of Object.entries({
      level: 'ActivityLevelResponse',
      ranking: 'RankingResponse',
      activity: 'ActivityPageResponse',
    })) {
      expect(
        document.paths[`/api/v1/posts/me/${route}`].get.responses['200']
          .content['application/json'].schema,
      ).toEqual({ $ref: `#/components/schemas/${name}` });
    }
    const schemas = document.components.schemas;
    expect(schemas.ActivityLevelResponse.required).toEqual(
      expect.arrayContaining([
        'participation',
        'agreeReceived',
        'picks',
        'score',
        'level',
        'title',
      ]),
    );
    expect(schemas.ActivityLevelResponse.properties.level.enum).toEqual([
      1, 2, 3, 4,
    ]);
    expect(schemas.RankingResponse.properties.items.items).toEqual({
      $ref: '#/components/schemas/RankingItemResponse',
    });
    expect(schemas.RankingResponse.properties.myRank.nullable).toBe(true);
    expect(schemas.RankingItemResponse.properties.authorNickname.nullable).toBe(
      true,
    );
    expect(schemas.ActivityPageResponse.properties.items).toMatchObject({
      maxItems: 20,
      items: { $ref: '#/components/schemas/ActivityItemResponse' },
    });
    expect(schemas.ActivityPageResponse.properties.nextCursor.nullable).toBe(
      true,
    );
    expect(schemas.ActivityItemResponse.properties.kind.enum).toEqual([
      'POST',
      'COMMENT',
      'REACTION',
      'COMMENT_REACTION',
      'VOTE',
    ]);
    expect(schemas.ActivityItemResponse.required).toContain('postStatus');
    expect(schemas.ActivityItemResponse.properties.postStatus.enum).toEqual([
      'ACTIVE',
      'EXPIRED',
    ]);
    expect(schemas.ActivityItemResponse.properties.closedAt).toMatchObject({
      format: 'date-time',
      nullable: true,
    });
    expect(schemas.ActivityItemResponse.properties.commentId.nullable).toBe(
      true,
    );
  });
});
