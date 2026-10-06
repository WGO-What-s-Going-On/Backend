import type { StoredModerationResult } from './moderation-result.js';

export const MODERATION_RESULT_REPOSITORY = Symbol(
  'MODERATION_RESULT_REPOSITORY',
);

export interface ModerationResultRepository {
  find(eventId: string): Promise<StoredModerationResult | null>;
  save(result: StoredModerationResult): Promise<boolean>;
}
