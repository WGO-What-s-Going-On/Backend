import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CreateReportRequest } from './report.dto.js';

@Injectable()
export class ReportTarget {
  async verify(_input: CreateReportRequest): Promise<void> {
    // Post currently trusts only the WS Gateway on internal reads. Until Post
    // authorizes Moderation, never fall back to an unauthenticated public read
    // or impersonate another service. Existing reports can still be retried
    // and withdrawn; only first-time intake requires target verification.
    throw new ServiceUnavailableException(
      'Authenticated Moderation-to-Post target verification is not supported',
    );
  }
}
