import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';
import type { CreateReportRequest, StoredReport } from './report.dto.js';

@Injectable()
export class ReportStore implements OnModuleDestroy {
  private readonly pool: Pool | undefined;
  constructor(config: ConfigService) {
    const url = config.get<string>('reports.databaseUrl');
    // No fallback to User's database or a TTL cache. Infrastructure must provision
    // a Moderation-owned database and apply the explicit migration first.
    if (url) {
      this.pool = new Pool({
        connectionString: url,
        max: 5,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 10000,
        statement_timeout: 5000,
        query_timeout: 7000,
      });
      this.pool.on('error', () => undefined);
    }
  }
  get configured(): boolean {
    return this.pool !== undefined;
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Report database is not configured',
      );
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
  async find(
    userId: string,
    input: CreateReportRequest,
  ): Promise<StoredReport | null> {
    return this.transaction(async (client) => {
      const found = await client.query<{ document: StoredReport }>(
        'SELECT document FROM moderation_reports WHERE reporter_user_id=$1 AND target_type=$2 AND post_id=$3 AND comment_id=$4',
        [userId, input.targetType, input.postId, input.commentId ?? ''],
      );
      return found.rows[0]?.document ?? null;
    });
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
