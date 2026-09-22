import { BadRequestException, Body, Controller, Get, Headers, Patch, Query, UnauthorizedException } from '@nestjs/common';

import type { NicknameAvailabilityResponse } from './dto/nickname-availability-response.dto.js';
import { UsersService } from './users.service.js';

import { normalizeNickname } from './nickname.js';
import type { UpdateUserProfile, UserProfileResponse } from './dto/user-profile.dto.js';

@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('nickname/availability')
  getNicknameAvailability(
    @Query('nickname') nickname: unknown,
  ): Promise<NicknameAvailabilityResponse> {
    return this.usersService.checkNicknameAvailability(normalizeNickname(nickname));
  }

  @Get('me')
  getMe(@Headers('x-user-id') userId: unknown): Promise<UserProfileResponse> {
    return this.usersService.getProfile(requireUserId(userId));
  }

  @Patch('me')
  updateMe(@Headers('x-user-id') userId: unknown, @Body() body: unknown): Promise<UserProfileResponse> {
    const id = requireUserId(userId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Invalid profile update');
    }
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'nickname' && key !== 'profileImageKey') ||
        (!Object.hasOwn(input, 'nickname') && !Object.hasOwn(input, 'profileImageKey'))) {
      throw new BadRequestException('Provide nickname or profileImageKey only');
    }
    const update: UpdateUserProfile = {};
    if (Object.hasOwn(input, 'nickname')) update.nickname = normalizeNickname(input.nickname);
    if (Object.hasOwn(input, 'profileImageKey')) {
      if (input.profileImageKey !== null &&
          (typeof input.profileImageKey !== 'string' || [...input.profileImageKey].length > 500)) {
        throw new BadRequestException('profileImageKey must be null or a string of at most 500 characters');
      }
      update.profileImageKey = input.profileImageKey as string | null;
    }
    return this.usersService.updateProfile(id, update);
  }
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new UnauthorizedException('Invalid authentication credentials');
  }
  return value;
}
