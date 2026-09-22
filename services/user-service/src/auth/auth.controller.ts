import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service.js';
import type { KakaoLoginResponse } from './dto/kakao-login-response.dto.js';
import type { RefreshResponse } from './dto/refresh-response.dto.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('kakao')
  loginWithKakao(@Body() body: unknown): Promise<KakaoLoginResponse> {
    if (!isRecord(body) || typeof body.authorizationCode !== 'string') {
      throw new BadRequestException('authorizationCode is required');
    }

    const authorizationCode = body.authorizationCode.trim();
    if (!authorizationCode) {
      throw new BadRequestException('authorizationCode must not be empty');
    }

    return this.authService.loginWithKakao(authorizationCode);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown): Promise<RefreshResponse> {
    if (!isRecord(body) || typeof body.refreshToken !== 'string') {
      throw new UnauthorizedException('Invalid authentication credentials');
    }
    return this.authService.refresh(body.refreshToken);
  }

  // Internal endpoint: only the trusted Gateway may supply these verified claims.
  @Post('logout')
  @HttpCode(204)
  logout(
    @Headers('x-user-id') userId: unknown,
    @Headers('x-session-id') sessionId: unknown,
  ): Promise<void> {
    if (typeof userId !== 'string' || !UUID_PATTERN.test(userId) ||
        typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) {
      throw new UnauthorizedException('Invalid authentication credentials');
    }
    return this.authService.logout(userId, sessionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
