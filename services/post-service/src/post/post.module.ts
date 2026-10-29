import { Activities, ActivityController } from './activity.controller.js';
import { NearbyController, NearbyPosts } from './nearby.controller.js';
import { GrpcNearbyPosts } from './semantic/grpc-candidates.js';
import { FrontendViews } from './infrastructure/frontend-views.js';
import { UserProfiles } from './infrastructure/user-profiles.js';
import { MediaSchema } from './media/media.schema.js';
import { MediaService } from './media/media.service.js';
import { S3MediaStorage } from './media/s3-media.storage.js';
import { MediaCleanupWorker } from './media/media.worker.js';
import { MediaController } from './media/media.controller.js';
import { ApplyModerationLifecycle } from './application/moderation.js';
import { ModerationWorker } from './infrastructure/moderation-consumer.js';
import { PostLifecycle } from './application/lifecycle.js';
import { ExpirationWorker } from './infrastructure/expiration.worker.js';
import { VoteWorker } from './infrastructure/vote.worker.js';
import { MongooseVote } from './infrastructure/mongoose-vote.js';
import { SemanticModule } from './semantic/semantic.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InternalPostController, PostController } from './post.controller.js';
import {
  CreateComment,
  CreateCommentReaction,
  CreatePost,
  CreateReaction,
  JoinPost,
} from './application/commands.js';
import { ReadPosts } from './application/queries.js';
import {
  HashPartitionStrategy,
  PARTITION_STRATEGY,
} from './application/partition.js';
import type { PartitionStrategy } from './application/partition.js';
import {
  LOCATION_AUTHORIZATION,
  POST_READ_QUERIES,
  POST_STATE_QUERIES,
  POST_UNIT_OF_WORK,
} from './application/ports.js';
import type {
  LocationAuthorization,
  PostReadQueries,
  PostStateQueries,
  PostUnitOfWork,
} from './application/ports.js';
import { GrpcLocationAuthorization } from './infrastructure/grpc-location.authorization.js';
import { MongoosePostRead } from './infrastructure/mongoose-post.read.js';
import { MongoosePostStore } from './infrastructure/mongoose-post.store.js';
import {
  ModerationReceiptSchema,
  CommentSchema,
  CommentReactionSchema,
  CounterSchema,
  OutboxSchema,
  ParticipantSchema,
  PostSchema,
  ReactionSchema,
  VoteSelectionSchema,
} from './infrastructure/post.schemas.js';
import { OutboxWorker } from './infrastructure/outbox.worker.js';

@Module({
  imports: [
    SemanticModule,
    MongooseModule.forFeature([
      { name: 'Media', schema: MediaSchema, collection: 'post_media' },
      { name: 'Post', schema: PostSchema, collection: 'posts' },
      {
        name: 'ModerationReceipt',
        schema: ModerationReceiptSchema,
        collection: 'moderation_receipts',
      },
      {
        name: 'VoteSelection',
        schema: VoteSelectionSchema,
        collection: 'post_vote_selections',
      },
      { name: 'Comment', schema: CommentSchema, collection: 'post_comments' },
      {
        name: 'CommentReaction',
        schema: CommentReactionSchema,
        collection: 'post_comment_reactions',
      },
      { name: 'Counter', schema: CounterSchema, collection: 'post_counters' },
      {
        name: 'Reaction',
        schema: ReactionSchema,
        collection: 'post_reactions',
      },
      {
        name: 'Participant',
        schema: ParticipantSchema,
        collection: 'post_participants',
      },
      { name: 'Outbox', schema: OutboxSchema, collection: 'outbox_events' },
    ]),
  ],
  controllers: [
    ActivityController,
    NearbyController,
    MediaController,
    PostController,
    InternalPostController,
  ],
  providers: [
    Activities,
    NearbyPosts,
    GrpcNearbyPosts,
    FrontendViews,
    UserProfiles,
    MediaService,
    S3MediaStorage,
    MediaCleanupWorker,
    MongoosePostStore,
    MongoosePostRead,
    MongooseVote,
    { provide: PARTITION_STRATEGY, useClass: HashPartitionStrategy },
    { provide: POST_READ_QUERIES, useExisting: MongoosePostRead },
    {
      provide: ReadPosts,
      useFactory: (
        queries: PostReadQueries,
        media: MediaService,
        views: FrontendViews,
      ) => new ReadPosts(queries, media, views),
      inject: [POST_READ_QUERIES, MediaService, FrontendViews],
    },
    { provide: POST_UNIT_OF_WORK, useExisting: MongoosePostStore },
    { provide: POST_STATE_QUERIES, useExisting: MongoosePostStore },
    {
      provide: LOCATION_AUTHORIZATION,
      useClass: GrpcLocationAuthorization,
    },
    {
      provide: CreatePost,
      useFactory: (
        unitOfWork: PostUnitOfWork,
        authorization: LocationAuthorization,
      ) => new CreatePost(unitOfWork, authorization),
      inject: [POST_UNIT_OF_WORK, LOCATION_AUTHORIZATION],
    },
    {
      provide: CreateComment,
      useFactory: (
        unitOfWork: PostUnitOfWork,
        queries: PostStateQueries,
        partition: PartitionStrategy,
        authorization: LocationAuthorization,
      ) => new CreateComment(unitOfWork, queries, partition, authorization),
      inject: [
        POST_UNIT_OF_WORK,
        POST_STATE_QUERIES,
        PARTITION_STRATEGY,
        LOCATION_AUTHORIZATION,
      ],
    },
    {
      provide: CreateCommentReaction,
      useFactory: (unitOfWork: PostUnitOfWork, queries: PostStateQueries) =>
        new CreateCommentReaction(unitOfWork, queries),
      inject: [POST_UNIT_OF_WORK, POST_STATE_QUERIES],
    },
    {
      provide: CreateReaction,
      useFactory: (
        unitOfWork: PostUnitOfWork,
        queries: PostStateQueries,
        partition: PartitionStrategy,
      ) => new CreateReaction(unitOfWork, queries, partition),
      inject: [POST_UNIT_OF_WORK, POST_STATE_QUERIES, PARTITION_STRATEGY],
    },
    {
      provide: JoinPost,
      useFactory: (
        unitOfWork: PostUnitOfWork,
        queries: PostStateQueries,
        authorization: LocationAuthorization,
        partition: PartitionStrategy,
      ) => new JoinPost(unitOfWork, queries, authorization, partition),
      inject: [
        POST_UNIT_OF_WORK,
        POST_STATE_QUERIES,
        LOCATION_AUTHORIZATION,
        PARTITION_STRATEGY,
      ],
    },
    {
      provide: PostLifecycle,
      useFactory: (unitOfWork: PostUnitOfWork, partition: PartitionStrategy) =>
        new PostLifecycle(unitOfWork, partition),
      inject: [POST_UNIT_OF_WORK, PARTITION_STRATEGY],
    },
    {
      provide: ApplyModerationLifecycle,
      useFactory: (unitOfWork: PostUnitOfWork) =>
        new ApplyModerationLifecycle(unitOfWork),
      inject: [POST_UNIT_OF_WORK],
    },
    ModerationWorker,
    ExpirationWorker,
    VoteWorker,
    OutboxWorker,
  ],
})
export class PostModule {}
