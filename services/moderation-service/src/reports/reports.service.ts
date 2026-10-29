import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ReportStore } from './report.store.js';
import { ReportTarget } from './report-target.js';
import {
  ReportStatus,
  parseReport,
  reportIdPattern,
  response,
  type StoredReport,
} from './report.dto.js';

@Injectable()
export class ReportsService {
  constructor(
    private readonly store: ReportStore,
    private readonly target: ReportTarget,
  ) {}
  async create(userId: string, body: unknown) {
    const input = parseReport(body);
    return this.available(async () => {
      const existing = await this.store.find(userId, input);
      if (existing) return this.existing(existing);
      await this.target.verify(input);
      return this.store.transaction(async (client) => {
        // One report per reporter/target for its entire lifetime. The advisory
        // lock covers the absent-row case across all application instances.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            JSON.stringify([
              userId,
              input.targetType,
              input.postId,
              input.commentId ?? '',
            ]),
          ],
        );
        const found = await client.query<{ document: StoredReport }>(
          'SELECT document FROM moderation_reports WHERE reporter_user_id=$1 AND target_type=$2 AND post_id=$3 AND comment_id=$4',
          [userId, input.targetType, input.postId, input.commentId ?? ''],
        );
        if (found.rows[0]) return this.existing(found.rows[0].document);
        const now = new Date().toISOString();
        const report: StoredReport = {
          ...input,
          reporterUserId: userId,
          reportId: `report_${randomUUID()}`,
          status: ReportStatus.PENDING,
          createdAt: now,
          withdrawnAt: null,
        };
        await client.query(
          'INSERT INTO moderation_reports(report_id, reporter_user_id, target_type, post_id, comment_id, document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            report.reportId,
            userId,
            input.targetType,
            input.postId,
            input.commentId ?? '',
            report,
          ],
        );
        await this.event(client, report, 'REPORT_CREATED', now);
        return response(report);
      });
    });
  }
  async withdraw(userId: string, reportId: string) {
    if (!reportIdPattern.test(reportId))
      throw new NotFoundException('Report not found');
    return this.available(() =>
      this.store.transaction(async (client) => {
        const found = await client.query<{ document: StoredReport }>(
          'SELECT document FROM moderation_reports WHERE report_id=$1 AND reporter_user_id=$2 FOR UPDATE',
          [reportId, userId],
        );
        const report = found.rows[0]?.document;
        if (!report) throw new NotFoundException('Report not found');
        if (report.status === ReportStatus.WITHDRAWN) return response(report);
        if (report.status !== ReportStatus.PENDING)
          throw new ConflictException('Reviewed report cannot be withdrawn');
        report.status = ReportStatus.WITHDRAWN;
        report.withdrawnAt = new Date().toISOString();
        await client.query(
          'UPDATE moderation_reports SET document=$2 WHERE report_id=$1',
          [reportId, report],
        );
        await this.event(
          client,
          report,
          'REPORT_WITHDRAWN',
          report.withdrawnAt,
        );
        return response(report);
      }),
    );
  }
  private existing(report: StoredReport) {
    if (report.status === ReportStatus.WITHDRAWN)
      throw new ConflictException('Withdrawn target cannot be reported again');
    return response(report);
  }
  private async event(
    client: PoolClient,
    report: StoredReport,
    eventType: string,
    occurredAt: string,
  ) {
    const eventId = randomUUID();
    const event = {
      eventId,
      eventType,
      schemaVersion: 1,
      producer: 'moderation-service',
      occurredAt,
      data: {
        reportId: report.reportId,
        reporterUserId: report.reporterUserId,
        targetType: report.targetType,
        postId: report.postId,
        ...(report.commentId ? { commentId: report.commentId } : {}),
        ...(eventType === 'REPORT_CREATED'
          ? { reason: report.reason }
          : { withdrawnAt: occurredAt }),
      },
    };
    await client.query(
      'INSERT INTO moderation_report_outbox(event_id, report_id, event_type, envelope) VALUES($1,$2,$3,$4)',
      [eventId, report.reportId, eventType, event],
    );
  }
  private async available<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Report storage unavailable');
    }
  }
}
