import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import type { NicknameAvailabilityResponse } from './dto/nickname-availability-response.dto.js';
import { UsersService } from './users.service.js';

const MAX_NICKNAME_LENGTH = 30;

@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('nickname/availability')
  getNicknameAvailability(
    @Query('nickname') nickname: unknown,
  ): Promise<NicknameAvailabilityResponse> {
    if (typeof nickname !== 'string') {
      throw new BadRequestException('nickname is required');
    }

    const trimmedNickname = nickname.trim();

    if (!trimmedNickname) {
      throw new BadRequestException('nickname must not be empty');
    }

    if ([...trimmedNickname].length > MAX_NICKNAME_LENGTH) {
      throw new BadRequestException(`nickname must be at most ${MAX_NICKNAME_LENGTH} characters`);
    }

    return this.usersService.checkNicknameAvailability(trimmedNickname);
  }
}
