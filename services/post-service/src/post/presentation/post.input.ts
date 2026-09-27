import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PostInput } from '../domain/post.js';

type Body = Record<string, unknown>;

function object(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('JSON object required');
  return value as Body;
}

function fields(body: Body, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Unknown field');
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string')
    throw new BadRequestException(`${name} must be a string`);
  return value.trim();
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number')
    throw new BadRequestException(`${name} must be a number`);
  return value;
}

export function userId(header: string | undefined): number {
  if (process.env.NODE_ENV === 'production')
    throw new ServiceUnavailableException(
      'Authentication integration unavailable',
    );
  if (
    !header ||
    !/^[1-9]\d*$/.test(header) ||
    !Number.isSafeInteger(Number(header))
  )
    throw new ForbiddenException('Valid X-User-Id required');
  return Number(header);
}

export function postId(value: string): string {
  if (!/^post_[0-9a-f-]{36}$/.test(value))
    throw new BadRequestException('Invalid postId');
  return value;
}

export function postInput(raw: unknown): PostInput {
  const body = object(raw);
  fields(body, [
    'title',
    'content',
    'category',
    'latitude',
    'longitude',
    'radiusM',
  ]);
  const category = string(body.category, 'category');
  return {
    title: string(body.title, 'title'),
    content: string(body.content, 'content'),
    category,
    latitude: number(body.latitude, 'latitude'),
    longitude: number(body.longitude, 'longitude'),
    radiusM: number(body.radiusM, 'radiusM'),
  };
}

export function commentInput(raw: unknown): string {
  const body = object(raw);
  fields(body, ['content']);
  return string(body.content, 'content');
}

export function reactionInput(raw: unknown): void {
  const body = object(raw);
  fields(body, ['type']);
  if (body.type !== 'LIKE')
    throw new BadRequestException('Only LIKE is supported');
}

export function participantInput(raw: unknown): void {
  fields(object(raw), []);
}
