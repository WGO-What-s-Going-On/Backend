import { BadgeEntity } from './badge.entity.js';
import { OAuthAccountEntity } from './oauth-account.entity.js';
import { OutboxEventEntity } from './outbox-event.entity.js';
import { TermEntity } from './term.entity.js';
import { UserBadgeEntity } from './user-badge.entity.js';
import { UserBlockEntity } from './user-block.entity.js';
import { UserTermConsentEntity } from './user-term-consent.entity.js';
import { UserEntity } from './user.entity.js';

export const USER_SERVICE_ENTITIES = [
  UserEntity,
  OAuthAccountEntity,
  TermEntity,
  UserTermConsentEntity,
  BadgeEntity,
  UserBadgeEntity,
  UserBlockEntity,
  OutboxEventEntity,
];

export {
  BadgeEntity,
  OAuthAccountEntity,
  OutboxEventEntity,
  TermEntity,
  UserBadgeEntity,
  UserBlockEntity,
  UserEntity,
  UserTermConsentEntity,
};
