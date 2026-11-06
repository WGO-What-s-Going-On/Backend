import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mergeDocuments, validateDocument } from '../src/openapi.js';
import { frontendAuth } from './frontend-auth-fixture.js';

const load = (path: string) =>
  import(
    new URL(`../../../services/post-service/dist/${path}`, import.meta.url).href
  );

// Post 빌드의 실제 Swagger를 통합해 Gateway가 제공하는 문서까지 확인한다.
// post-service 빌드 후 RUN_POST_GATEWAY_E2E=1로 실행하며 DB는 사용하지 않는다.
it.skipIf(process.env.RUN_POST_GATEWAY_E2E !== '1')(
  'serves expired read and write policies in integrated Post Swagger',
  async () => {
    const requirePost = createRequire(
      new URL('../../../services/post-service/package.json', import.meta.url),
    );
    const { Test } = requirePost('@nestjs/testing');
    const { PostController } = await load('post/post.controller.js');
    const commands = await load('post/application/commands.js');
    const { ReadPosts } = await load('post/application/queries.js');
    const { PostLifecycle } = await load('post/application/lifecycle.js');
    const { MongooseVote } = await load('post/infrastructure/mongoose-vote.js');
    const { MediaService } = await load('post/media/media.service.js');
    const { FindSimilarPosts } = await load('post/semantic/search.js');
    const { POST_STATE_QUERIES, LOCATION_AUTHORIZATION } = await load(
      'post/application/ports.js',
    );
    const { Activities, ActivityController } = await load(
      'post/activity.controller.js',
    );
    const module = await Test.createTestingModule({
      controllers: [PostController, ActivityController],
      providers: [
        commands.CreatePost,
        commands.CreateComment,
        commands.CreateReaction,
        commands.CreateCommentReaction,
        commands.JoinPost,
        ReadPosts,
        PostLifecycle,
        MongooseVote,
        MediaService,
        FindSimilarPosts,
        POST_STATE_QUERIES,
        LOCATION_AUTHORIZATION,
        Activities,
      ].map((provide) => ({ provide, useValue: {} })),
    }).compile();
    const post = module.createNestApplication();
    const { configureSwagger } = await load('swagger.js');
    configureSwagger(post);
    const directory = await mkdtemp(join(tmpdir(), 'wgo-post-openapi-'));
    let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await post.listen(0, '127.0.0.1');
      const source = await (
        await fetch(`${await post.getUrl()}/docs/openapi.json`)
      ).json();
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        !('paths' in source)
      )
        throw new Error('Post OpenAPI document required');
      const config = loadConfig();
      config.userAuth = frontendAuth;
      config.rateLimit.enabled = false;
      config.docs.enabled = true;
      config.docs.live = false;
      config.docs.file = join(directory, 'openapi.json');
      const merged = await mergeDocuments(
        [{ service: 'post', document: source }],
        config,
      );
      await validateDocument(merged);
      await writeFile(config.docs.file, JSON.stringify(merged));
      gateway = await buildApp({ config, logger: false });
      const response = await gateway.inject({
        method: 'GET',
        url: '/docs/openapi.json',
      });
      expect(response.statusCode).toBe(200);
      const document = response.json();
      for (const suffix of ['', '/comments']) {
        const operation = document.paths[`/api/v1/posts/{postId}${suffix}`].get;
        expect(operation.description).toContain('EXPIRED');
        expect(operation.responses['404'].description).toContain('DELETED');
        expect(operation.security).toBeDefined();
      }
      for (const suffix of [
        '/comments',
        '/reactions',
        '/comments/{commentId}/reactions',
      ]) {
        const operation =
          document.paths[`/api/v1/posts/{postId}${suffix}`].post;
        expect(operation.description).toContain('EXPIRED');
        expect(operation.responses['403']).toBeDefined();
      }
      expect(
        document.components.schemas.post__ActivityItemResponse.properties
          .postStatus.enum,
      ).toEqual(['ACTIVE', 'EXPIRED']);
      expect(
        (await gateway.inject({ method: 'GET', url: '/docs' })).statusCode,
      ).toBe(200);
    } finally {
      await gateway?.close();
      await post.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
