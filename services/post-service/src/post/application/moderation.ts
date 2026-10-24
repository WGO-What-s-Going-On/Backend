import { PostNotFoundError } from '../domain/post.js';
import { event } from './event.js';
import type { PostUnitOfWork } from './ports.js';

export interface ModerationLifecycleEvent {
  eventId: string;
  eventType: 'BOARD_STALE' | 'BOARD_REACTIVATED' | 'BOARD_CLOSED';
  postId: string;
  occurredAt: Date;
  correlationId: string;
}

export class ApplyModerationLifecycle {
  constructor(private readonly unitOfWork: PostUnitOfWork) {}

  async execute(input: ModerationLifecycleEvent): Promise<void> {
    await this.unitOfWork.execute(async (tx) => {
      // 처리 기록도 같은 트랜잭션에 넣어 ACK 유실·동시 재전달에서 중복 종료를 막는다.
      if (!(await tx.commands.recordModerationEvent(input))) return;
      const post = await tx.queries.findPost(input.postId);
      if (!post) throw new PostNotFoundError('Moderation target not found');
      // v1에는 순서 버전이 없다. 유예 상태를 복제하거나 종료된 게시물을 되살리지 않는다.
      if (input.eventType !== 'BOARD_CLOSED' || post.status !== 'ACTIVE')
        return;
      const now = new Date();
      const postVersion = post.postVersion + 1;
      await tx.commands.fenceActivities(post.postId, post.bucketCount);
      await tx.commands.closeVote(post.postId, now);
      // CLOSED가 발생한 시각을 종료 효력 시각으로 보존하고 실제 적용 시각과 구분한다.
      await tx.commands.scheduleExpiration(post.postId, input.occurredAt, now);
      await tx.commands.changePostStatus(
        post.postId,
        'EXPIRED',
        now,
        postVersion,
      );
      const expired = event(
        post.postId,
        'PostExpired',
        {
          post: {
            postId: post.postId,
            authorId: post.authorId,
            category: post.category,
            expiresAt: input.occurredAt,
            expiredAt: now,
          },
          postVersion,
          sourceEventId: input.eventId,
        },
        now,
      );
      expired.correlationId = input.correlationId;
      await tx.commands.appendEvent(expired);
    });
  }
}
