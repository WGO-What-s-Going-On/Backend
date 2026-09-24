import { Body, Controller, Headers, Param, Post, UseFilters } from '@nestjs/common';
import { CreateComment, CreatePost, CreateReaction, JoinPost } from './application/commands.js';
import { PostErrorFilter } from './presentation/post-error.filter.js';
import { commentInput, participantInput, postId, postInput, reactionInput, userId } from './presentation/post.input.js';

@Controller('api/v1/posts')
@UseFilters(PostErrorFilter)
export class PostController {
  constructor(
    private readonly createPost: CreatePost,
    private readonly createComment: CreateComment,
    private readonly createReaction: CreateReaction,
    private readonly joinPost: JoinPost,
  ) {}

  @Post()
  create(@Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createPost.execute(postInput(body), authorId);
  }

  @Post(':postId/comments')
  comment(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const authorId = userId(header);
    return this.createComment.execute(postId(id), commentInput(body), authorId);
  }

  @Post(':postId/reactions')
  reaction(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    reactionInput(body);
    return this.createReaction.execute(postId(id), actorId);
  }

  @Post(':postId/participants')
  participant(@Param('postId') id: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    const actorId = userId(header);
    participantInput(body);
    return this.joinPost.execute(postId(id), actorId);
  }
}
