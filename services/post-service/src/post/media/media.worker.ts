import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MediaService } from './media.service.js';

@Injectable()
export class MediaCleanupWorker {
  private readonly logger = new Logger(MediaCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopped = false;
  private cursor = '';
  constructor(
    private readonly media: MediaService,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
  ) {}
  onModuleInit() {
    if (!this.media.storage.config.enabled) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() =>
        this.logger.warn('Media cleanup failed; retrying next interval'),
      );
    }, this.media.storage.config.cleanupMs);
    this.timer.unref();
  }
  async runOnce() {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = this.sweep();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async sweep() {
    this.media.storage.requireEnabled();
    const now = new Date();
    const records = this.media.records;
    // 첨부와 같은 행을 조건부 변경하므로 READY가 동시에 삭제 대상으로 전환될 수 없다.
    const abandoned = await records
      .find({ status: { $in: ['PENDING', 'READY'] }, expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(50)
      .lean();
    for (const row of abandoned)
      await records.updateOne(
        {
          mediaId: row.mediaId,
          status: { $in: ['PENDING', 'READY'] },
          expiresAt: { $lte: now },
        },
        {
          $set: {
            status: 'DELETING',
            cleanupAt: new Date(now.getTime() + 300000),
          },
        },
      );
    // 종료 상태는 되돌릴 수 없다. 커서로 bounded scan해 앞쪽의 활성 첨부가 정리를 막지 않게 한다.
    const attached = await records
      .find({ status: 'ATTACHED', mediaId: { $gt: this.cursor } })
      .sort({ mediaId: 1 })
      .limit(50)
      .lean();
    for (const row of attached) {
      const post = await this.posts
        .findOne({ postId: row.postId }, 'status')
        .lean();
      const comment = row.commentId
        ? await this.comments
            .findOne({ postId: row.postId, commentId: row.commentId }, 'status')
            .lean()
        : undefined;
      if (
        !post ||
        ['DELETED', 'EXPIRED'].includes(post.status) ||
        (row.commentId && (!comment || comment.status === 'DELETED'))
      )
        await records.updateOne(
          { mediaId: row.mediaId, status: 'ATTACHED' },
          {
            $set: {
              status: 'DELETING',
              cleanupAt: new Date(now.getTime() + 300000),
            },
          },
        );
    }
    this.cursor = attached.length === 50 ? attached.at(-1)!.mediaId : '';
    const due = await records
      .find({ status: 'DELETING', cleanupAt: { $lte: now } })
      .sort({ cleanupAt: 1 })
      .limit(50)
      .lean();
    for (const row of due) {
      if (this.stopped) break;
      try {
        // S3 삭제는 멱등하다. 실패 시 기록을 남겨 재시도하고 여러 worker도 같은 키만 지운다.
        await this.media.storage.remove(row);
        await records.deleteOne({ mediaId: row.mediaId, status: 'DELETING' });
      } catch {
        await records.updateOne(
          { mediaId: row.mediaId, status: 'DELETING' },
          { $set: { cleanupAt: new Date(Date.now() + 300000) } },
        );
        this.logger.warn('Media object cleanup failed; retained for retry');
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
