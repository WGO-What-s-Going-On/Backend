import { Module } from '@nestjs/common';
import { GatewayAuthGuard } from './gateway-auth.guard.js';
import { ReportOutboxWorker } from './report-outbox.worker.js';
import { ReportStore } from './report.store.js';
import { ReportTarget } from './report-target.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
@Module({
  controllers: [ReportsController],
  providers: [
    GatewayAuthGuard,
    ReportStore,
    ReportTarget,
    ReportsService,
    ReportOutboxWorker,
  ],
})
export class ReportsModule {}
