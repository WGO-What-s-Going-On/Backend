import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import type { ModerationResultRepository } from './moderation-result.repository.js';
import type { StoredModerationResult } from './moderation-result.js';

@Injectable()
export class RedisModerationResultRepository
  implements ModerationResultRepository, OnModuleDestroy
{
  private readonly redis;

  constructor(config: ConfigService) {
    this.redis = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
    });
    this.redis.on('error', () => undefined);
  }

  async find(eventId: string): Promise<StoredModerationResult | null> {
    await this.connect();
    const value = await this.redis.get(`moderation:content:${eventId}`);
    return value ? (JSON.parse(value) as StoredModerationResult) : null;
  }

  async save(result: StoredModerationResult): Promise<boolean> {
    await this.connect();
    return (
      (await this.redis.set(
        `moderation:content:${result.eventId}`,
        JSON.stringify(result),
        { NX: true, EX: 2_592_000 },
      )) === 'OK'
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  private async connect(): Promise<void> {
    if (!this.redis.isOpen) await this.redis.connect();
  }
}
