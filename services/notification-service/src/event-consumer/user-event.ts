import {
  check,
  natural,
  object,
  text,
  time,
  uid,
  wire,
} from './event-validation.js';
export interface UserNotificationEvent {
  eventId: string;
  type: string;
  userId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}
const amount = (v: unknown) =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(v) &&
  BigInt(v) <= 9223372036854775807n;
export function parseUserEvent(
  fields: Record<string, string>,
): UserNotificationEvent {
  const v = wire(fields);
  check(
    text(v.type) &&
      v.type === fields.eventType &&
      v.version === 1 &&
      v.producer === 'user-service' &&
      time(v.occurredAt) &&
      text(v.correlationId) &&
      object(v.target) &&
      v.target.type === 'USER' &&
      uid(v.target.id) &&
      object(v.payload),
    'User envelope',
  );
  const p = v.payload,
    type = v.type;
  if (
    [
      'USER_BADGE_GRANTED',
      'USER_BADGE_REVOKED',
      'USER_LEVEL_CHANGED',
      'USER_CREDIT_CHANGED',
    ].includes(type)
  ) {
    check(
      p.userId === v.target.id &&
        text(p.sourceEventId) &&
        text(p.policyVersion),
      'User target',
    );
    if (type.startsWith('USER_BADGE_')) {
      check(uid(p.badgeId), 'badge ID');
      if (p.badgeCode !== undefined)
        check(
          typeof p.badgeCode === 'string' &&
            /^[A-Z][A-Z0-9_]{0,79}$/.test(p.badgeCode),
          'badge code',
        );
      if (p.badgeName !== undefined)
        check(text(p.badgeName) && p.badgeName.length <= 200, 'badge name');
      if (p.regionCode !== undefined && p.regionCode !== null)
        check(
          typeof p.regionCode === 'string' && /^[0-9]{10}$/.test(p.regionCode),
          'badge region',
        );
      if (p.regionName !== undefined && p.regionName !== null)
        check(text(p.regionName), 'badge region name');
      if (p.rankingRunId !== undefined && p.rankingRunId !== null)
        check(
          typeof p.rankingRunId === 'string' &&
            /^[0-9a-f-]{36}$/.test(p.rankingRunId),
          'ranking run',
        );
      for (const key of ['score', 'rank'])
        if (p[key] !== undefined && p[key] !== null)
          check(amount(p[key]), `badge ${key}`);
    } else if (type === 'USER_LEVEL_CHANGED') {
      check(
        natural(p.level) &&
          ['INITIAL', 'UP', 'DOWN'].includes(String(p.changeType)),
        'level change',
      );
      check(
        p.changeType === 'INITIAL'
          ? p.previousLevel === null
          : natural(p.previousLevel) &&
              (p.changeType === 'UP'
                ? p.level > p.previousLevel
                : p.level < p.previousLevel),
        'level direction',
      );
    } else {
      check(
        uid(p.ledgerId) &&
          typeof p.delta === 'string' &&
          /^-?[1-9][0-9]{0,18}$/.test(p.delta) &&
          amount(p.credits) &&
          amount(p.growthScore),
        'credit change',
      );
    }
  }
  return {
    eventId: String(v.eventId),
    type,
    userId: v.target.id,
    occurredAt: String(v.occurredAt),
    payload: p,
  };
}
