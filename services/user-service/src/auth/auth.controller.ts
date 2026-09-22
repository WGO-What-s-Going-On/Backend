import { BadRequestException, Body, Controller, Post } from '@nestjs/common';

import { AuthService } from './auth.service.js';
import type { KakaoLoginResponse } from './dto/kakao-login-response.dto.js';

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
