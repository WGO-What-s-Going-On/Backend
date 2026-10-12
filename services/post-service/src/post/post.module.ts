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
      { name: 'Post', schema: PostSchema, collection: 'posts' },
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
  controllers: [PostController, InternalPostController],
  providers: [
    MongoosePostStore,
    MongoosePostRead,
    MongooseVote,
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
    ExpirationWorker,
    VoteWorker,
    OutboxWorker,
  ],
})
export class PostModule {}
