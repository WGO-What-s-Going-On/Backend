import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  NicknameAvailabilityResult,
  UserProfileResult,
  TermConsentsResult,
  UserBadgesResult,
  WithdrawalResult,
  userIdentityHeader,
  userErrorResponses,
} from '../http.openapi.js';

import type { NicknameAvailabilityResponse } from './dto/nickname-availability-response.dto.js';
import { UsersService } from './users.service.js';

import { normalizeNickname } from './nickname.js';
import type {
  UpdateUserProfile,
  UserProfileResponse,
} from './dto/user-profile.dto.js';
import {
  parseTermIds,
  type TermConsentsResponse,
} from './dto/term-consents.dto.js';
import type { UserBadgesResponse } from './dto/user-badges-response.dto.js';
import type { WithdrawalResponse } from './dto/withdrawal-response.dto.js';
import { parseUserId } from '../user-id.js';

@ApiTags('Users')
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('nickname/availability')
  @ApiOperation({
    summary: 'Check nickname availability',
    description:
      'Trims input and checks case-insensitive duplication. Prohibited-word checking is not implemented.',
  })
  @ApiQuery({
    name: 'nickname',
    required: true,
    schema: { type: 'string' },
    description:
      'Non-empty after trimming, at most 30 Unicode characters after trimming.',
  })
  @ApiResponse({ status: 200, type: NicknameAvailabilityResult })
  @userErrorResponses([400, 'Missing, blank or oversized nickname.'])
  getNicknameAvailability(
    @Query('nickname') nickname: unknown,
  ): Promise<NicknameAvailabilityResponse> {
    return this.usersService.checkNicknameAvailability(
      normalizeNickname(nickname),
    );
  }

  @Get('me')
  @ApiOperation({
    summary: 'Read own profile',
    description:
      'The current implementation has no separate account-status access restriction.',
  })
  @userIdentityHeader()
  @ApiResponse({ status: 200, type: UserProfileResult })
  @userErrorResponses([401, 'Invalid X-User-Id.'], [404, 'User not found.'])
  getMe(@Headers('x-user-id') userId: unknown): Promise<UserProfileResponse> {
    return this.usersService.getProfile(requireUserId(userId));
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update own profile',
    description:
      'Provide nickname and/or profileImageKey. Updating nickname completes onboarding. No separate account-status restriction is implemented.',
  })
  @userIdentityHeader()
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        nickname: {
          type: 'string',
          description:
            'Trimmed, non-empty nickname; at most 30 Unicode characters after trimming.',
        },
        profileImageKey: { type: 'string', maxLength: 500, nullable: true },
      },
    },
  })
  @ApiResponse({ status: 200, type: UserProfileResult })
  @userErrorResponses(
    [400, 'Invalid profile input or unknown fields.'],
    [401, 'Invalid X-User-Id.'],
    [404, 'User not found.'],
    [409, 'Nickname already in use.'],
  )
  updateMe(
    @Headers('x-user-id') userId: unknown,
    @Body() body: unknown,
    @Headers('x-request-id') requestId: unknown,
  ): Promise<UserProfileResponse> {
    const id = requireUserId(userId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Invalid profile update');
    }
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => key !== 'nickname' && key !== 'profileImageKey',
      ) ||
      (!Object.hasOwn(input, 'nickname') &&
        !Object.hasOwn(input, 'profileImageKey'))
    ) {
      throw new BadRequestException('Provide nickname or profileImageKey only');
    }
    const update: UpdateUserProfile = {};
    if (Object.hasOwn(input, 'nickname'))
      update.nickname = normalizeNickname(input.nickname);
    if (Object.hasOwn(input, 'profileImageKey')) {
      if (
        input.profileImageKey !== null &&
        (typeof input.profileImageKey !== 'string' ||
          [...input.profileImageKey].length > 500)
      ) {
        throw new BadRequestException(
          'profileImageKey must be null or a string of at most 500 characters',
        );
      }
      update.profileImageKey = input.profileImageKey as string | null;
    }
    return this.usersService.updateProfile(
      id,
      update,
      typeof requestId === 'string' && requestId.trim() ? requestId : undefined,
    );
  }

  @Post('me/term-consents')
  @ApiOperation({
    summary: 'Consent to current terms',
    description:
      'Include all currently effective required terms. Unknown, outdated or future terms are rejected. Does not change onboarding state.',
  })
  @userIdentityHeader()
  @ApiBody({
    schema: {
      type: 'object',
      required: ['termIds'],
      properties: {
        termIds: {
          type: 'array',
          minItems: 1,
          items: {
            oneOf: [
              { type: 'integer', minimum: 1, maximum: 9007199254740991 },
              {
                type: 'string',
                pattern: '^[0-9]{1,19}$',
                description:
                  'Positive decimal ID up to 9223372036854775807; send large BIGINT IDs as strings.',
              },
            ],
          },
          example: ['1', '2'],
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: TermConsentsResult })
  @userErrorResponses(
    [400, 'Invalid terms or missing required consent.'],
    [401, 'Invalid X-User-Id.'],
    [404, 'User not found.'],
  )
  @HttpCode(200)
  consentToTerms(
    @Headers('x-user-id') userId: unknown,
    @Body() body: unknown,
  ): Promise<TermConsentsResponse> {
    const id = requireUserId(userId);
    return this.usersService.consentToTerms(id, parseTermIds(body));
  }

  @Get('me/badges')
  @ApiOperation({
    summary: 'List own active badges',
    description:
      'Only active, unrecalled badges; sorted by grantedAt descending, then badgeId descending. Returns an empty array when none.',
  })
  @userIdentityHeader()
  @ApiResponse({ status: 200, type: UserBadgesResult })
  @userErrorResponses([401, 'Invalid X-User-Id.'], [404, 'User not found.'])
  getBadges(
    @Headers('x-user-id') userId: unknown,
  ): Promise<UserBadgesResponse> {
    return this.usersService.getBadges(requireUserId(userId));
  }

  @Post('me/withdrawal')
  @ApiOperation({
    summary: 'Request account withdrawal',
    description:
      'ACTIVE becomes WITHDRAWAL_PENDING with a 30-day recovery deadline. Repeated requests keep the original deadline. Clears all refresh sessions. Redis failure returns 503 and rolls back DB changes. Existing Access JWTs remain valid until expiry.',
  })
  @userIdentityHeader()
  @ApiResponse({ status: 200, type: WithdrawalResult })
  @userErrorResponses(
    [401, 'Invalid X-User-Id.'],
    [404, 'User not found.'],
    [409, 'Account state does not allow withdrawal.'],
    [503, 'Session cleanup unavailable.'],
  )
  @HttpCode(200)
  requestWithdrawal(
    @Headers('x-user-id') userId: unknown,
    @Headers('x-request-id') requestId: unknown,
  ): Promise<WithdrawalResponse> {
    return this.usersService.requestWithdrawal(
      requireUserId(userId),
      typeof requestId === 'string' && requestId.trim() ? requestId : undefined,
    );
  }
}

function requireUserId(value: unknown): string {
  const userId = parseUserId(value);
  if (!userId) {
    throw new UnauthorizedException('Invalid authentication credentials');
  }
  return userId;
}
