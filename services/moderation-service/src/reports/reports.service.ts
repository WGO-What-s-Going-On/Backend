import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReportStore } from './report.store.js';
import { ReportTarget } from './report-target.js';
import {
  ReportStatus,
  parseReport,
  reportIdPattern,
  response,
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
      if (existing) {
        if (existing.status === ReportStatus.WITHDRAWN)
          throw new ConflictException(
            'Withdrawn target cannot be reported again',
          );
        return response(existing);
      }
      await this.target.verify(input);
      const report = await this.store.create(
        {
          ...input,
          reporterUserId: userId,
          reportId: `report_${randomUUID()}`,
          status: ReportStatus.PENDING,
          createdAt: new Date().toISOString(),
          withdrawnAt: null,
        },
        randomUUID(),
      );
      return response(report);
    });
  }
  async withdraw(userId: string, reportId: string) {
    if (!reportIdPattern.test(reportId))
      throw new NotFoundException('Report not found');
    return this.available(async () =>
      response(
        await this.store.withdraw(
          userId,
          reportId,
          randomUUID(),
          new Date().toISOString(),
        ),
      ),
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
