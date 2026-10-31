import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { parseUserId } from '../../user-id.js';

export class CreateBlockRequest {
  @ApiProperty({
    example: '123',
    pattern: '^[1-9][0-9]{0,15}$',
    description: 'Decimal string ID, at most 9007199254740991.',
  })
  blockedUserId!: string;
}

export class BlockItem {
  @ApiProperty({ example: '123' }) userId!: string;
  @ApiProperty() nickname!: string;
  @ApiProperty({ type: String, nullable: true }) profileImageKey!:
    | string
    | null;
  @ApiProperty({ format: 'date-time' }) blockedAt!: string;
  @ApiProperty({
    format: 'date-time',
    deprecated: true,
    description: 'Compatibility alias of blockedAt.',
  })
  createdAt!: string;
}

export class BlockPage {
  @ApiProperty({ type: [BlockItem] }) items!: BlockItem[];
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opaque owner-bound cursor; ordered by blocked user ID descending.',
  })
  nextCursor!: string | null;
}

export function blockedUserId(value: unknown): string {
  const id = parseUserId(value);
  if (!id) throw new BadRequestException('Invalid blockedUserId');
  return id;
}

export function parseBlockBody(body: unknown): string {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, 'blockedUserId')
  )
    throw new BadRequestException('Provide blockedUserId only');
  return blockedUserId((body as Record<string, unknown>).blockedUserId);
}

export function parseBlockPage(owner: string, cursor: unknown, limit: unknown) {
  if (
    limit !== undefined &&
    (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit))
  )
    throw new BadRequestException('Invalid limit');
  const size = limit === undefined ? 30 : Number(limit);
  if (size > 100)
    throw new BadRequestException('Limit must be between 1 and 100');
  let before: string | undefined;
  let direction: 'ASC' | 'DESC' = 'DESC';
  // Continue numeric cursors issued by the former ascending dev API. New
  // cursors carry the ordering so page boundaries remain stable during rollout.
  if (parseUserId(cursor))
    return { size, before: cursor as string, direction: 'ASC' as const };
  if (cursor !== undefined) {
    try {
      if (
        typeof cursor !== 'string' ||
        cursor.length > 200 ||
        !/^[A-Za-z0-9_-]+$/.test(cursor)
      )
        throw new Error();
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (decoded.owner !== owner || !parseUserId(decoded.before))
        throw new Error();
      if (
        decoded.direction !== undefined &&
        !['ASC', 'DESC'].includes(decoded.direction)
      )
        throw new Error();
      before = decoded.before;
      direction = decoded.direction ?? 'DESC';
    } catch {
      throw new BadRequestException('Invalid block cursor');
    }
  }
  return { size, before, direction };
}
