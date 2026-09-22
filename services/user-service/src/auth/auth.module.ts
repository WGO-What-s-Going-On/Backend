import { Module } from '@nestjs/common';

import { AccessTokenService } from './access-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { KakaoOAuthClient } from './kakao-oauth.client.js';
import { RedisSessionStore } from './redis-session.store.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, KakaoOAuthClient, AccessTokenService, RedisSessionStore],
})
export class AuthModule {}
