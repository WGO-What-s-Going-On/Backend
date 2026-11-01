import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import type { CreateReportRequest, StoredReport } from './report.dto.js';
import { reportScript } from './report-script.js';

export const REPORT_REDIS_CLIENT = Symbol('REPORT_REDIS_CLIENT');
export const REPORT_KEY_PREFIX = 'moderation:reports:v1';

@Injectable()
export class ReportStore implements OnModuleDestroy {
  private readonly redis;
  private connecting: Promise<unknown> | undefined;
  readonly configured: boolean;
  readonly recordsKey: string;
  readonly pendingKey: string;
  readonly stream: string;
  constructor(
    config: ConfigService,
    @Optional()
    @Inject(REPORT_REDIS_CLIENT)
    client?: ReturnType<typeof createClient>,
  ) {
    const url = config.get<string>('redis.url');
    this.configured = !!url;
    this.stream =
      config.get<string>('reports.eventStream') ?? 'moderation:report-events';
    // Preserve legacy moderation:report:<hash> records in their own namespace.
    const prefix = config.get<string>('reports.keyPrefix') ?? REPORT_KEY_PREFIX;
    if (!/^moderation:reports:v1(?::[a-zA-Z0-9_-]+)?$/.test(prefix))
      throw new Error('Invalid report storage namespace');
    this.recordsKey = `${prefix}:records`;
    this.pendingKey = `${prefix}:pending`;
    if (
      [
        config.get<string>('redis.postEventStream') ?? 'post:events',
        config.get<string>('redis.moderationEventStream') ??
          'moderation:events',
        config.get<string>('redis.contentEventStream') ??
          'moderation:content-events',
        this.recordsKey,
        this.pendingKey,
      ].includes(this.stream)
    )
      throw new Error('Report events require a separate stream');
    this.redis =
      client ??
      createClient({
        url: url ?? 'redis://localhost:6383',
        disableOfflineQueue: true,
        commandOptions: { timeout: 2000 },
        commandsQueueMaxLength: 100,
        socket: { connectTimeout: 2000, reconnectStrategy: false },
      });
    this.redis.on('error', () => undefined);
  }
  async find(
    userId: string,
    input: CreateReportRequest,
  ): Promise<StoredReport | null> {
    return this.execute('find', this.digest(userId, input), userId);
  }
  async create(report: StoredReport, eventId: string): Promise<StoredReport> {
    return (await this.execute(
      'create',
      this.digest(report.reporterUserId, report),
      report.reporterUserId,
      report,
      eventId,
      report.createdAt,
    ))!;
  }
  async withdraw(
    userId: string,
    reportId: string,
    eventId: string,
    now: string,
  ): Promise<StoredReport> {
    const report = await this.execute(
      'withdraw',
      reportId,
      userId,
      undefined,
      eventId,
      now,
    );
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }
  async pending(cursor: string) {
    await this.connect();
    return this.redis.sScan(this.pendingKey, cursor, { COUNT: 20 });
  }
  async recover(digest: string): Promise<void> {
    await this.execute('recover', digest, '');
  }
  private digest(userId: string, input: CreateReportRequest): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          userId,
          input.targetType,
          input.postId,
          input.commentId ?? '',
        ]),
      )
      .digest('hex');
  }
  private async execute(
    action: string,
    lookup: string,
    userId: string,
    report?: StoredReport,
    eventId = '',
    now = '',
  ): Promise<StoredReport | null> {
    await this.connect();
    const raw = await this.redis.eval(reportScript, {
      keys: [this.recordsKey, this.pendingKey, this.stream],
      arguments: [
        action,
        lookup,
        userId,
        report ? JSON.stringify(report) : '',
        eventId,
        now,
      ],
    });
    const result = JSON.parse(String(raw)) as {
      code: string;
      report?: StoredReport;
    };
    if (result.code === 'WITHDRAWN')
      throw new ConflictException('Withdrawn target cannot be reported again');
    if (result.code === 'REVIEWED')
      throw new ConflictException('Reviewed report cannot be withdrawn');
    if (result.code === 'NOT_FOUND') return null;
    if (result.code !== 'OK' || !result.report)
      throw new Error('Invalid report storage response');
    return result.report;
  }
  private async connect(): Promise<void> {
    if (!this.configured)
      throw new ServiceUnavailableException('Report Redis is not configured');
    if (this.redis.isReady) return;
    this.connecting ??= this.redis.connect().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }
  async onModuleDestroy(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    if (this.redis.isOpen)
      await this.redis.quit().catch(() => this.redis.destroy());
  }
}
