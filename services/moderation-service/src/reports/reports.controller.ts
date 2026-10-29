import {
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { GatewayAuthGuard } from './gateway-auth.guard.js';
import {
  CreateReportRequest,
  ReportResponse,
  ReportHttpError,
} from './report.dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('Reports')
@ApiSecurity('service-jwt')
@ApiHeader({
  name: 'X-User-Id',
  required: true,
  description:
    'Verified Gateway context; public clients never set this header.',
  schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
})
@ApiResponse({
  status: 401,
  type: ReportHttpError,
  description: 'Invalid Gateway service JWT or user context.',
})
@ApiResponse({
  status: 404,
  type: ReportHttpError,
  description:
    'Target/report absent, inactive, or report owned by another user.',
})
@ApiResponse({
  status: 409,
  type: ReportHttpError,
  description:
    'Withdrawn target cannot be reported again; reviewed reports cannot be withdrawn.',
})
@ApiResponse({
  status: 503,
  type: ReportHttpError,
  description:
    'Report database or target verification unavailable/unconfigured.',
})
@UseGuards(GatewayAuthGuard)
@Controller('api/v1/moderation/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Post()
  @ApiOperation({
    summary: 'Report a post or comment',
    description:
      'One report per reporter and target for its lifetime. Retries return the original report without changing its reason/description. No automatic sanctions.',
  })
  @ApiBody({
    type: CreateReportRequest,
    description:
      'COMMENT requires commentId; POST forbids it. Unknown fields rejected.',
  })
  @ApiResponse({ status: 201, type: ReportResponse })
  @ApiResponse({
    status: 400,
    type: ReportHttpError,
    description:
      'Invalid reason, IDs, target fields or description (max 2000 characters).',
  })
  create(
    @Headers('x-user-id') userId: string,
    @Body() body: unknown,
  ): Promise<ReportResponse> {
    return this.reports.create(userId, body);
  }
  @Delete(':reportId')
  @ApiOperation({
    summary: 'Withdraw own pending report',
    description:
      'PENDING to WITHDRAWN; repeated withdrawal returns the original timestamp. REVIEWED returns 409. Audit data is retained, including after target deletion/expiry.',
  })
  @ApiParam({ name: 'reportId', type: String })
  @ApiResponse({ status: 200, type: ReportResponse })
  withdraw(
    @Headers('x-user-id') userId: string,
    @Param('reportId') reportId: string,
  ): Promise<ReportResponse> {
    return this.reports.withdraw(userId, reportId);
  }
}
