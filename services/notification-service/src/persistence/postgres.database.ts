import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { postgresConfig } from './postgres.config.js';

@Injectable()
export class PostgresDatabase implements OnModuleDestroy {
  readonly pool: Pool;
  private readonly logger = new Logger(PostgresDatabase.name);

  constructor(config: ConfigService) {
    this.pool = new Pool(
      config.get<PoolConfig>('database') ?? postgresConfig(),
    );
    this.pool.on('error', () =>
      this.logger.error('Idle PostgreSQL connection failed'),
    );
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
