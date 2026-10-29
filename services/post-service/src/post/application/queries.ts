import type { FrontendViews } from '../infrastructure/frontend-views.js';
import { PostNotFoundError } from '../domain/post.js';
import type { CommentCursor, PostReadQueries, MediaReadPort } from './ports.js';

export class ReadPosts {
  constructor(
    private readonly queries: PostReadQueries,
    private readonly media?: MediaReadPort,
    private readonly views?: FrontendViews,
  ) {}

  async detail(postId: string, actor?: number) {
    const post = await this.queries.findDetail(postId);
    if (
      !post ||
      post.status !== 'ACTIVE' ||
      (post.expiresAt && post.expiresAt <= new Date())
    )
      throw new PostNotFoundError('Post not found');
    return {
      ...(this.views ? (await this.views.posts([post], actor))[0]! : post),
      media: this.media ? (await this.media.forTargets([post]))[0]! : [],
    };
  }

  async comments(
    postId: string,
    cursor: CommentCursor | null,
    limit: number,
    actor?: number,
  ) {
    // 목록 조회에서 부모의 이미지 URL까지 불필요하게 서명하지 않는다.
    const post = await this.queries.findStatus(postId);
    if (
      !post ||
      post.status !== 'ACTIVE' ||
      (post.expiresAt && post.expiresAt <= new Date())
    )
      throw new PostNotFoundError('Post not found');
    // 한 건을 더 읽어 다음 페이지 여부를 판단한다. 커서에는 마지막 댓글의 정렬 키를 담는다.
    const rows = await this.queries.findComments(postId, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const media = this.media
      ? await this.media.forTargets(page.map(({ comment }) => comment))
      : [];
    const comments = page.map(({ comment }, index) => ({
      ...comment,
      media: media[index] ?? [],
    }));
    return {
      comments: this.views
        ? await this.views.comments(comments, actor)
        : comments,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                postId,
                createdAt: last.comment.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async batch(postIds: string[]) {
    if (!postIds.length) return { posts: [] };
    // 중복 ID는 한 번만 조회하되 결과 순서는 요청에 처음 등장한 순서를 따른다.
    const unique = [...new Set(postIds)];
    const found = await this.queries.findActiveBatch(unique);
    const byId = new Map(found.map((post) => [post.postId, post]));
    return {
      posts: unique.flatMap((id) => {
        const post = byId.get(id);
        return post ? [post] : [];
      }),
    };
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
