import { Injectable } from '@nestjs/common';
import { NotificationEventWriter } from '../persistence/notification-event.writer.js';
import { NotificationState } from '../redis/notification-state.js';
import { PostEventHandler } from './post-event.handler.js';
import { parseUserEvent } from './user-event.js';

@Injectable()
export class UserEventHandler {
  constructor(
    private readonly writer: NotificationEventWriter,
    private readonly state: NotificationState,
    private readonly deliveries: PostEventHandler,
  ) {}
  async handle(fields: Record<string, string>) {
    const event = parseUserEvent(fields),
      p = event.payload;
    const recipients = await this.writer.record(
      'user:events',
      event.eventId,
      { type: event.type },
      async (client) => {
        const badge = ['USER_BADGE_GRANTED', 'USER_BADGE_REVOKED'].includes(
          event.type,
        );
        const level =
          event.type === 'USER_LEVEL_CHANGED' && p.changeType !== 'INITIAL';
        if (!badge && !level) return [];
        const metadata: Record<string, unknown> = {};
        for (const key of [
          'badgeId',
          'badgeCode',
          'badgeName',
          'stage',
          'regionCode',
          'regionName',
          'rankingRunId',
          'rank',
          'score',
          'level',
          'previousLevel',
          'changeType',
          'policyVersion',
        ])
          if (p[key] !== undefined) metadata[key] = p[key];
        const granted = event.type === 'USER_BADGE_GRANTED',
          up = level && p.changeType === 'UP';
        const name = typeof p.badgeName === 'string' ? p.badgeName : '칭호';
        // Own achievements are not social actions; no actor/self exclusion applies.
        const result = await this.writer.write(client, {
          stream: 'user:events',
          eventId: event.eventId,
          userId: event.userId,
          businessKey: JSON.stringify([
            event.type,
            p.sourceEventId,
            p.policyVersion,
            p.badgeId ?? null,
            p.regionCode ?? null,
            p.level ?? null,
          ]),
          type: event.type,
          title: badge
            ? granted
              ? '칭호 획득'
              : '칭호 변경'
            : up
              ? '레벨 상승'
              : '레벨 변경',
          body: badge
            ? granted
              ? `${name} 칭호를 획득했습니다.`
              : `${name} 칭호가 회수되었습니다.`
            : `레벨이 ${p.level}(으)로 변경되었습니다.`,
          category: 'rewards',
          push: granted || !!up,
          metadata,
        });
        return result?.created ? [event.userId] : [];
      },
    );
    for (const userId of recipients) await this.state.invalidateUnread(userId);
    // A duplicate after COMMIT can recover its already-persisted delivery.
    await this.deliveries.dispatch();
  }
}
