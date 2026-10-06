import type { Model } from 'mongoose';
import { serializePostEvent } from './post-event-envelope.js';

// 운영자 CLI 전용이다. HTTP/WS 사용자에게 Outbox 원문이나 재발행 권한을 노출하지 않는다.
export class OutboxRecovery {
  constructor(private readonly outbox: Model<any>) {}

  async failed(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('limit must be 1–100');
    return this.outbox
      .find(
        { status: 'FAILED' },
        'eventId eventType aggregateId attemptCount totalAttempts replayCount failedAt lastError -_id',
      )
      .sort({ failedAt: 1, eventId: 1 })
      .limit(limit)
      .lean();
  }

  async retry(eventId: string, reason: string): Promise<void> {
    if (
      !/^evt_[0-9a-f-]{36}$/.test(eventId) ||
      !reason.trim() ||
      reason.length > 500
    )
      throw new Error('Valid event ID and reason (1–500 characters) required');
    const row = await this.outbox.findOne({ eventId, status: 'FAILED' }).lean();
    if (!row)
      throw new Error(
        'FAILED event not found; active or published events cannot be replayed',
      );
    // 손상된 payload는 원인 수정 없이 재발행하지 않는다. eventId와 발생 시각은 바꾸지 않는다.
    serializePostEvent(row);
    const result = await this.outbox.updateOne(
      {
        _id: row._id,
        status: 'FAILED',
        replayCount: row.replayCount ?? { $exists: false },
      },
      {
        $set: {
          status: 'PENDING',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          claimedBy: null,
          claimedUntil: null,
          replayedAt: new Date(),
          replayReason: reason.trim(),
        },
        $inc: { replayCount: 1 },
      },
    );
    if (result.modifiedCount !== 1)
      throw new Error('Event changed concurrently; reload its status');
  }
}
