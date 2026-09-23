import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostController } from './post.controller.js';
import { PostService } from './post.service.js';
import { CommentSchema, OutboxSchema, ParticipantSchema, PostSchema, ReactionSchema } from './post.schemas.js';
import { OutboxWorker } from './outbox.worker.js';

@Module({
  imports: [MongooseModule.forFeature([
    { name: 'Post', schema: PostSchema, collection: 'posts' },
    { name: 'Comment', schema: CommentSchema, collection: 'post_comments' },
    { name: 'Reaction', schema: ReactionSchema, collection: 'post_reactions' },
    { name: 'Participant', schema: ParticipantSchema, collection: 'post_participants' },
    { name: 'Outbox', schema: OutboxSchema, collection: 'outbox_events' },
  ])],
  controllers: [PostController],
  providers: [PostService, OutboxWorker],
})
export class PostModule {}
