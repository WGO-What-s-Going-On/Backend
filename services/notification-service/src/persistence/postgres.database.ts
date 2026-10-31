import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { postgresConfig } from './postgres.config.js';

@Injectable()
export class PostgresDatabase implements OnApplicationShutdown {
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
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }

  // Consumer와 delivery worker의 onModuleDestroy가 끝난 뒤 pool을 닫는다.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
