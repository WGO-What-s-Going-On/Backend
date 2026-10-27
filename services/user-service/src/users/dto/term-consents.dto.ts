import { BadRequestException } from '@nestjs/common';

export interface TermConsentsResponse {
  termIds: string[];
}

export function parseTermIds(body: unknown): string[] {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('termIds' in body) ||
    !Array.isArray(body.termIds) ||
    body.termIds.length === 0
  ) {
    throw new BadRequestException('termIds must be a non-empty array');
  }
  const ids = body.termIds.map((value: unknown) => {
    if (
      typeof value === 'number' &&
      (!Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new BadRequestException(
        'termIds must contain positive integer IDs',
      );
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(
        'termIds must contain positive integer IDs',
      );
    }
    const id = String(value);
    if (
      !/^[0-9]{1,19}$/.test(id) ||
      BigInt(id) <= 0n ||
      BigInt(id) > 9223372036854775807n
    ) {
      throw new BadRequestException('Invalid term ID');
    }
    return BigInt(id).toString();
  });
  return [...new Set(ids)];
}
