import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostSchema } from '../infrastructure/post.schemas.js';
import { GrpcLocationAuthorization } from '../infrastructure/grpc-location.authorization.js';
import {
  createEmbeddingProvider,
  EMBEDDING_PROVIDER,
  NEARBY_POST_CANDIDATES,
  SEMANTIC_SOURCE,
  SEMANTIC_POST_INDEX,
  type EmbeddingProvider,
  type NearbyPostCandidates,
  type SemanticPostIndex,
  type SemanticSource,
} from './ports.js';
import { GrpcNearbyPosts } from './grpc-candidates.js';
import { MongooseSemanticSource } from './mongoose-source.js';
import { ElasticsearchIndex } from './elasticsearch.js';
import { FindSimilarPosts } from './search.js';
import { IndexSemanticPost } from './index-post.js';
import { SemanticWorker } from './worker.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Post', schema: PostSchema, collection: 'posts' },
    ]),
  ],
  providers: [
    GrpcLocationAuthorization,
    { provide: EMBEDDING_PROVIDER, useFactory: createEmbeddingProvider },
    { provide: NEARBY_POST_CANDIDATES, useClass: GrpcNearbyPosts },
    { provide: SEMANTIC_SOURCE, useClass: MongooseSemanticSource },
    {
      provide: SEMANTIC_POST_INDEX,
      useFactory: () => new ElasticsearchIndex(),
    },
    {
      provide: FindSimilarPosts,
      useFactory: (
        auth: GrpcLocationAuthorization,
        nearby: NearbyPostCandidates,
        source: SemanticSource,
        embedding: EmbeddingProvider,
        index: SemanticPostIndex,
      ) =>
        new FindSimilarPosts(
          auth,
          nearby,
          source,
          embedding,
          index,
          process.env.SEMANTIC_THRESHOLD?.trim()
            ? Number(process.env.SEMANTIC_THRESHOLD)
            : undefined,
          process.env.SEMANTIC_ENABLED !== 'false',
        ),
      inject: [
        GrpcLocationAuthorization,
        NEARBY_POST_CANDIDATES,
        SEMANTIC_SOURCE,
        EMBEDDING_PROVIDER,
        SEMANTIC_POST_INDEX,
      ],
    },
    {
      provide: IndexSemanticPost,
      useFactory: (
        source: SemanticSource,
        embedding: EmbeddingProvider,
        index: SemanticPostIndex,
      ) => new IndexSemanticPost(source, embedding, index),
      inject: [SEMANTIC_SOURCE, EMBEDDING_PROVIDER, SEMANTIC_POST_INDEX],
    },
    SemanticWorker,
  ],
  exports: [FindSimilarPosts],
})
export class SemanticModule {}
