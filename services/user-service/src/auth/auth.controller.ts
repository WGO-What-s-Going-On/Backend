import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  KakaoLoginResult,
  RefreshResult,
  userIdentityHeader,
  userErrorResponses,
} from '../http.openapi.js';

import { AuthService } from './auth.service.js';
import type { KakaoLoginResponse } from './dto/kakao-login-response.dto.js';
import type { RefreshResponse } from './dto/refresh-response.dto.js';
import { parseUserId } from '../user-id.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('Auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('kakao')
  @ApiOperation({
    summary: 'Kakao login or account creation',
    description:
      'Exchanges the authorization code using configured Kakao credentials. Restores withdrawal-pending accounts only before their deadline. Returns user Access JWT and rotating opaque refresh token.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['authorizationCode'],
      properties: {
        authorizationCode: {
          type: 'string',
          minLength: 1,
          description: 'Trimmed, non-empty Kakao authorization code.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: KakaoLoginResult })
  @userErrorResponses(
    [400, 'Missing or blank authorizationCode.'],
    [401, 'Kakao authentication failed or account unavailable.'],
    [503, 'Account creation or authentication session unavailable.'],
  )
  loginWithKakao(
    @Body() body: unknown,
    @Headers('x-request-id') requestId: unknown,
  ): Promise<KakaoLoginResponse> {
    if (!isRecord(body) || typeof body.authorizationCode !== 'string') {
      throw new BadRequestException('authorizationCode is required');
    }

    const authorizationCode = body.authorizationCode.trim();
    if (!authorizationCode) {
      throw new BadRequestException('authorizationCode must not be empty');
    }

    return this.authService.loginWithKakao(
      authorizationCode,
      typeof requestId === 'string' && requestId.trim() ? requestId : undefined,
    );
  }

  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate refresh token',
    description:
      'Checks the session token hash and ACTIVE account state. The previous token becomes invalid after successful rotation.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: {
        refreshToken: {
          type: 'string',
          description:
            'session UUID + dot + 43-character base64url secret, as returned by login/refresh.',
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: RefreshResult })
  @userErrorResponses(
    [401, 'Missing, invalid, expired, reused token or inactive account.'],
    [503, 'Authentication session unavailable.'],
  )
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<RefreshResponse> {
    if (!isRecord(body) || typeof body.refreshToken !== 'string') {
      throw new UnauthorizedException('Invalid authentication credentials');
    }
    return this.authService.refresh(body.refreshToken);
  }

  // Internal endpoint: only the trusted Gateway may supply these verified claims.
  @Post('logout')
  @ApiOperation({
    summary: 'Revoke one refresh session',
    description:
      'Reads user/session context headers directly. User Bearer verification at the Gateway is not connected. Revokes the matching refresh session; issued Access JWT remains valid until expiry.',
  })
  @userIdentityHeader()
  @ApiHeader({
    name: 'X-Session-Id',
    required: true,
    description:
      'UUID session ID, the prefix before the dot in the current refresh token. Must belong to X-User-Id.',
    schema: { type: 'string', format: 'uuid', pattern: UUID_PATTERN.source },
  })
  @ApiResponse({
    status: 204,
    description: 'Session revoked; no response body.',
  })
  @userErrorResponses(
    [401, 'Invalid identity context or session not owned by user.'],
    [503, 'Authentication session unavailable.'],
  )
  @HttpCode(204)
  logout(
    @Headers('x-user-id') userId: unknown,
    @Headers('x-session-id') sessionId: unknown,
  ): Promise<void> {
    const parsedUserId = parseUserId(userId);
    if (
      !parsedUserId ||
      typeof sessionId !== 'string' ||
      !UUID_PATTERN.test(sessionId)
    ) {
      throw new UnauthorizedException('Invalid authentication credentials');
    }
    return this.authService.logout(parsedUserId, sessionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
