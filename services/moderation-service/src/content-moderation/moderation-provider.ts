import type { ModerationResult } from './moderation-result.js';

export const MODERATION_PROVIDER = Symbol('MODERATION_PROVIDER');

export interface ModerationProvider {
  moderate(content: string): Promise<ModerationResult>;
}

export class ModerationProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModerationProviderError';
  }
}
