import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthController } from '../src/health/health.controller.js';
import {
  CreateComment,
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
      controllers: [HealthController, PostController, InternalPostController],
      providers: [
        CreatePost,
        CreateComment,
        CreateReaction,
        JoinPost,
        ReadPosts,
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
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v1/posts',
        '/api/v1/posts/{postId}',
        '/api/v1/posts/{postId}/comments',
        '/api/v1/posts/{postId}/participants',
        '/api/v1/posts/{postId}/reactions',
        '/health/live',
        '/internal/v1/posts/batch-get',
        '/internal/v1/posts/{postId}',
        '/internal/v1/posts/{postId}/comments',
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
  });
});
