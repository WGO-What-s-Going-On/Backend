import { BadRequestException } from '@nestjs/common';

export function normalizeNickname(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('nickname is required');
  const nickname = value.trim();
  if (!nickname) throw new BadRequestException('nickname must not be empty');
  if ([...nickname].length > 30) {
    throw new BadRequestException('nickname must be at most 30 characters');
  }
  return nickname;
}
