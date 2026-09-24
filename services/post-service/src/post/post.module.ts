import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostController } from './post.controller.js';
import { CreateComment, CreatePost, CreateReaction, JoinPost } from './application/commands.js';
import { PARTICIPATION_AUTHORIZATION, POST_STATE_QUERIES, POST_UNIT_OF_WORK } from './application/ports.js';
import type { ParticipationAuthorization, PostStateQueries, PostUnitOfWork } from './application/ports.js';
import { LocalParticipationAuthorization } from './infrastructure/local-participation.authorization.js';
import { MongoosePostStore } from './infrastructure/mongoose-post.store.js';
import { CommentSchema, OutboxSchema, ParticipantSchema, PostSchema, ReactionSchema } from './infrastructure/post.schemas.js';
import { OutboxWorker } from './infrastructure/outbox.worker.js';

@Module({
  imports: [MongooseModule.forFeature([
    { name: 'Post', schema: PostSchema, collection: 'posts' },
    { name: 'Comment', schema: CommentSchema, collection: 'post_comments' },
    { name: 'Reaction', schema: ReactionSchema, collection: 'post_reactions' },
    { name: 'Participant', schema: ParticipantSchema, collection: 'post_participants' },
    { name: 'Outbox', schema: OutboxSchema, collection: 'outbox_events' },
  ])],
  controllers: [PostController],
  providers: [
    MongoosePostStore,
    { provide: POST_UNIT_OF_WORK, useExisting: MongoosePostStore },
    { provide: POST_STATE_QUERIES, useExisting: MongoosePostStore },
    { provide: PARTICIPATION_AUTHORIZATION, useClass: LocalParticipationAuthorization },
    { provide: CreatePost, useFactory: (unitOfWork: PostUnitOfWork) => new CreatePost(unitOfWork), inject: [POST_UNIT_OF_WORK] },
    { provide: CreateComment, useFactory: (unitOfWork: PostUnitOfWork) => new CreateComment(unitOfWork), inject: [POST_UNIT_OF_WORK] },
    { provide: CreateReaction, useFactory: (unitOfWork: PostUnitOfWork, queries: PostStateQueries) => new CreateReaction(unitOfWork, queries), inject: [POST_UNIT_OF_WORK, POST_STATE_QUERIES] },
    { provide: JoinPost, useFactory: (unitOfWork: PostUnitOfWork, queries: PostStateQueries, authorization: ParticipationAuthorization) => new JoinPost(unitOfWork, queries, authorization), inject: [POST_UNIT_OF_WORK, POST_STATE_QUERIES, PARTICIPATION_AUTHORIZATION] },
    OutboxWorker,
  ],
})
export class PostModule {}
