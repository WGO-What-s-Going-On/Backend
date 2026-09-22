import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_INFO_URL = 'https://kapi.kakao.com/v2/user/me';

@Injectable()
export class KakaoOAuthClient {
  private readonly restApiKey: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService) {
    this.restApiKey = requiredConfig(config, 'auth.kakao.restApiKey');
    this.clientSecret = requiredConfig(config, 'auth.kakao.clientSecret');
    this.redirectUri = requiredConfig(config, 'auth.kakao.redirectUri');
  }

  async exchangeAuthorizationCode(authorizationCode: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.restApiKey,
      redirect_uri: this.redirectUri,
      code: authorizationCode,
      client_secret: this.clientSecret,
    });

    try {
      const response = await fetch(KAKAO_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!response.ok) {
        throw new UnauthorizedException('Kakao authentication failed');
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
        throw new UnauthorizedException('Kakao authentication failed');
      }

      return payload.access_token;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Kakao authentication failed');
    }
  }

  async getUserId(kakaoAccessToken: string): Promise<string> {
    try {
      const response = await fetch(KAKAO_USER_INFO_URL, {
        headers: { authorization: `Bearer ${kakaoAccessToken}` },
      });

      if (!response.ok) {
        throw new UnauthorizedException('Kakao authentication failed');
      }

      const responseText = await response.text();
      const payload: unknown = JSON.parse(responseText);
      if (!isRecord(payload) || !Object.hasOwn(payload, 'id')) {
        throw new UnauthorizedException('Kakao authentication failed');
      }

      const providerUserId = extractPrecisionSafeId(responseText, payload.id);

      if (!providerUserId) {
        throw new UnauthorizedException('Kakao authentication failed');
      }

      return providerUserId;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Kakao authentication failed');
    }
  }
}

function requiredConfig(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractPrecisionSafeId(responseText: string, parsedId: unknown): string | undefined {
  if (typeof parsedId === 'string') {
    return /^[0-9]+$/.test(parsedId) ? parsedId : undefined;
  }

  if (typeof parsedId !== 'number' || !Number.isFinite(parsedId)) {
    return undefined;
  }

  const matches = responseText.matchAll(/"id"\s*:\s*([0-9]+)/g);
  for (const match of matches) {
    const candidate = match[1];
    if (candidate && Number(candidate) === parsedId) {
      return candidate;
    }
  }

  return undefined;
}
