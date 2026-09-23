import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { PostService } from './post.service.js';

@Controller('api/v1/posts')
export class PostController {
  constructor(private readonly service: PostService) {}

  @Post()
  create(@Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    return this.service.createPost(body, this.service.userId(header));
  }

  @Post(':postId/comments')
  comment(@Param('postId') postId: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    return this.service.createComment(postId, body, this.service.userId(header));
  }

  @Post(':postId/reactions')
  reaction(@Param('postId') postId: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    return this.service.createReaction(postId, body, this.service.userId(header));
  }

  @Post(':postId/participants')
  participant(@Param('postId') postId: string, @Headers('x-user-id') header: string | undefined, @Body() body: unknown) {
    return this.service.join(postId, body, this.service.userId(header));
  }
}
