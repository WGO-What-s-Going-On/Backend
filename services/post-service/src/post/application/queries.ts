import { PostNotFoundError } from '../domain/post.js';
import type { CommentCursor, PostReadQueries } from './ports.js';

export class ReadPosts {
  constructor(private readonly queries: PostReadQueries) {}

  async detail(postId: string) {
    const post = await this.queries.findDetail(postId);
    if (!post || post.status !== 'ACTIVE') throw new PostNotFoundError('Post not found');
    return post;
  }

  async comments(postId: string, cursor: CommentCursor | null, limit: number) {
    await this.detail(postId);
    const rows = await this.queries.findComments(postId, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      comments: page.map(({ comment }) => comment),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ postId, createdAt: last.comment.createdAt.toISOString(), id: last.id })).toString('base64url')
        : null,
    };
  }

  async batch(postIds: string[]) {
    if (!postIds.length) return { posts: [] };
    const unique = [...new Set(postIds)];
    const found = await this.queries.findActiveBatch(unique);
    const byId = new Map(found.map((post) => [post.postId, post]));
    return { posts: unique.flatMap((id) => { const post = byId.get(id); return post ? [post] : []; }) };
  }

  async meta(postId: string) {
    const post = await this.queries.findMeta(postId);
    if (!post) throw new PostNotFoundError('Post not found');
    return post;
  }

  async status(postId: string) {
    const post = await this.queries.findStatus(postId);
    if (!post) throw new PostNotFoundError('Post not found');
    return post;
  }
}
