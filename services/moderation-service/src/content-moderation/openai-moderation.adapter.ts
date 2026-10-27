import { Inject, Injectable, Optional, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(OpenAiModerationAdapter.name);
  private readonly client: OpenAI | undefined;

  constructor(
    config: ConfigService,
    @Optional() @Inject(OPENAI_CLIENT) client?: OpenAI,
  ) {
    const apiKey = config.get<string>('openai.apiKey')?.trim();
    this.client =
      client ??
      (apiKey
        ? new OpenAI({
            apiKey,
            timeout: 10_000,
            maxRetries: 2,
          })
        : undefined);
  }

  async moderate(content: string): Promise<ModerationResult> {
    const started = performance.now();
    try {
      if (!this.client)
        throw new ModerationProviderError(
          'OpenAI moderation is not configured',
          false,
        );
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
      if (
        typeof result.flagged !== 'boolean' ||
        typeof response.model !== 'string' ||
        !response.model.trim() ||
        !result.categories ||
        !result.category_scores ||
        Array.isArray(result.categories) ||
        Array.isArray(result.category_scores) ||
        Object.keys(result.categories).length === 0 ||
        !Object.values(result.categories).every(
          (v) => typeof v === 'boolean',
        ) ||
        !Object.values(result.category_scores).every(
          (v) =>
            typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
        ) ||
        Object.keys(result.categories).sort().join(',') !==
          Object.keys(result.category_scores).sort().join(',')
      )
        throw new ModerationProviderError(
          'Invalid OpenAI moderation response',
          false,
        );
      this.logger.log(
        JSON.stringify({
          event: 'openai_moderation_completed',
          service: 'moderation-service',
          durationMs: Math.round(performance.now() - started),
        }),
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
      this.logger.warn(
        JSON.stringify({
          event: 'openai_moderation_failed',
          service: 'moderation-service',
          durationMs: Math.round(performance.now() - started),
        }),
      );
      if (error instanceof ModerationProviderError) throw error;
      const candidate = (error as { status?: unknown }).status;
      const status = typeof candidate === 'number' ? candidate : undefined;
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
