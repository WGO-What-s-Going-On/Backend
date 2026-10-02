import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InternalPostController, PostController } from './post.controller.js';
import {
  CreateComment,
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
  CommentSchema,
  CounterSchema,
  OutboxSchema,
  ParticipantSchema,
  PostSchema,
  ReactionSchema,
} from './infrastructure/post.schemas.js';
import { OutboxWorker } from './infrastructure/outbox.worker.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Post', schema: PostSchema, collection: 'posts' },
      { name: 'Comment', schema: CommentSchema, collection: 'post_comments' },
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
  controllers: [PostController, InternalPostController],
  providers: [
    MongoosePostStore,
    MongoosePostRead,
    { provide: PARTITION_STRATEGY, useClass: HashPartitionStrategy },
    { provide: POST_READ_QUERIES, useExisting: MongoosePostRead },
    {
      provide: ReadPosts,
      useFactory: (queries: PostReadQueries) => new ReadPosts(queries),
      inject: [POST_READ_QUERIES],
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
      ) => new CreateComment(unitOfWork, queries, partition),
      inject: [POST_UNIT_OF_WORK, POST_STATE_QUERIES, PARTITION_STRATEGY],
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
    OutboxWorker,
  ],
})
export class PostModule {}
