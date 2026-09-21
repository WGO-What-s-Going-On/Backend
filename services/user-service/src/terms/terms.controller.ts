import { Controller, Get } from '@nestjs/common';

import type { TermsResponse } from './dto/terms-response.dto.js';
import { TermsService } from './terms.service.js';

@Controller('api/v1/terms')
export class TermsController {
  constructor(private readonly termsService: TermsService) {}

  @Get()
  getCurrentTerms(): Promise<TermsResponse> {
    return this.termsService.findCurrentTerms();
  }
}
