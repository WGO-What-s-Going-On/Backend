import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TermEntity } from '../database/entities/term.entity.js';
import type { TermsResponse } from './dto/terms-response.dto.js';

@Injectable()
export class TermsService {
  constructor(
    @InjectRepository(TermEntity)
    private readonly termsRepository: Repository<TermEntity>,
  ) {}

  async findCurrentTerms(): Promise<TermsResponse> {
    const terms = await this.termsRepository
      .createQueryBuilder('term')
      .distinctOn(['term.code'])
      .where('term.effectiveAt <= CURRENT_TIMESTAMP')
      .orderBy('term.code', 'ASC')
      .addOrderBy('term.effectiveAt', 'DESC')
      .addOrderBy('term.id', 'DESC')
      .getMany();

    return {
      terms: terms.map((term) => ({
        termId: term.id,
        code: term.code,
        version: term.version,
        required: term.required,
        documentUrl: term.documentUrl,
        effectiveAt: term.effectiveAt.toISOString(),
      })),
    };
  }
}
