import { Controller, Get } from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TermsResult } from '../http.openapi.js';

import type { TermsResponse } from './dto/terms-response.dto.js';
import { TermsService } from './terms.service.js';

@ApiTags('Terms')
@Controller('api/v1/terms')
export class TermsController {
  constructor(private readonly termsService: TermsService) {}

  @Get()
  @ApiOperation({
    summary: 'List current effective terms',
    description:
      'Latest effective version per code; ties use descending ID. Service-only route: the current HTTP Gateway does not route /api/v1/terms.',
  })
  @ApiResponse({ status: 200, type: TermsResult })
  getCurrentTerms(): Promise<TermsResponse> {
    return this.termsService.findCurrentTerms();
  }
}
