import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';

@Injectable()
export class AccessTokenService {
  readonly expiresIn: number;

  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: ConfigService) {
    this.secret = new TextEncoder().encode(requiredConfig(config, 'auth.jwt.accessSecret'));
    this.issuer = requiredConfig(config, 'auth.jwt.issuer');
    this.audience = requiredConfig(config, 'auth.jwt.audience');
    this.expiresIn = positiveIntegerConfig(config, 'auth.jwt.accessTtlSeconds');
  }

  create(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.expiresIn)
      .sign(this.secret);
  }
}

function requiredConfig(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function positiveIntegerConfig(config: ConfigService, key: string): number {
  const value = Number(requiredConfig(config, key));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}
