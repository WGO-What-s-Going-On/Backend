import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_INFO_URL = 'https://kapi.kakao.com/v2/user/me';

@Injectable()
export class KakaoOAuthClient {
  private readonly restApiKey: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string | undefined;
  private readonly redirectUris: Set<string>;

  constructor(config: ConfigService) {
    this.restApiKey = requiredConfig(config, 'auth.kakao.restApiKey');
    this.clientSecret = requiredConfig(config, 'auth.kakao.clientSecret');
    this.redirectUri = config.get<string>('auth.kakao.redirectUri')?.trim();
    const configured = config.get<string>('auth.kakao.redirectUris');
    const uris =
      configured === undefined
        ? [this.redirectUri ?? '']
        : configured.split(',').map((uri) => uri.trim());
    if (uris.some((uri) => !validRedirectUri(uri)))
      throw new Error(
        'Kakao redirect URIs must be HTTPS URLs or HTTP localhost URLs without credentials or fragments',
      );
    this.redirectUris = new Set(uris);
    if (this.redirectUri && !this.redirectUris.has(this.redirectUri))
      throw new Error(
        'KAKAO_REDIRECT_URI must be included in KAKAO_REDIRECT_URIS',
      );
  }

  async exchangeAuthorizationCode(
    authorizationCode: string,
    redirectUri?: string,
  ): Promise<string> {
    // 생략한 기존 요청만 기본값을 사용한다. 명시한 값은 정규화하지 않고 정확히 대조한다.
    const selectedUri =
      redirectUri === undefined ? this.redirectUri : redirectUri;
    if (!selectedUri || !this.redirectUris.has(selectedUri))
      throw new BadRequestException(
        'redirectUri must match an allowed Kakao redirect URI',
      );
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.restApiKey,
      redirect_uri: selectedUri,
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
      if (
        !isRecord(payload) ||
        typeof payload.access_token !== 'string' ||
        !payload.access_token
      ) {
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

function extractPrecisionSafeId(
  responseText: string,
  parsedId: unknown,
): string | undefined {
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

function validRedirectUri(uri: string): boolean {
  if (!uri || uri.length > 2048 || uri.includes('*')) return false;
  try {
    const url = new URL(uri);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && url.hostname === 'localhost'))
    );
  } catch {
    return false;
  }
}
