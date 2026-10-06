import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import {
  ModerationProviderError,
  type ModerationProvider,
} from './moderation-provider.js';
import type { ModerationResult } from './moderation-result.js';

export const OPENAI_CLIENT = Symbol('OPENAI_CLIENT');

@Injectable()
export class OpenAiModerationAdapter implements ModerationProvider {
  private readonly client: OpenAI;

  constructor(
    config: ConfigService,
    @Optional() @Inject(OPENAI_CLIENT) client?: OpenAI,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: config.get<string>('openai.apiKey') ?? 'missing',
        timeout: 10_000,
        maxRetries: 2,
      });
  }

  async moderate(content: string): Promise<ModerationResult> {
    try {
      const response = await this.client.moderations.create({
        model: 'omni-moderation-latest',
        input: content,
      });
      const result = response.results[0];
      if (!result)
        throw new ModerationProviderError(
          'OpenAI returned no moderation result',
          false,
        );
      return {
        flagged: result.flagged,
        categories: result.categories as unknown as Record<string, boolean>,
        categoryScores: result.category_scores as unknown as Record<
          string,
          number
        >,
        model: response.model,
      };
    } catch (error) {
      if (error instanceof ModerationProviderError) throw error;
      const status =
        error instanceof OpenAI.APIError ? error.status : undefined;
      const retryable =
        status === undefined ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500;
      throw new ModerationProviderError('OpenAI moderation failed', retryable, {
        cause: error,
      });
    }
  }
}
