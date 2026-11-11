import { mediaIds } from '../media/media.policy.js';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommentReactionType, PostReactionType } from '../domain/post.js';
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
    'anonymous',
    'title',
    'content',
    'category',
    'latitude',
    'longitude',
    'radiusM',
    'mediaIds',
    'coverFocus',
    'displayPosition',
  ]);
  if (body.anonymous !== undefined && typeof body.anonymous !== 'boolean')
    throw new BadRequestException('anonymous must be a boolean');
  const category = string(body.category, 'category');
  return {
    ...(body.mediaIds === undefined
      ? {}
      : { mediaIds: mediaIds(body.mediaIds) }),
    ...(body.coverFocus === undefined
      ? {}
      : { coverFocus: coverFocus(body.coverFocus) }),
    ...(body.displayPosition === undefined
      ? {}
      : { displayPosition: displayPosition(body.displayPosition) }),
    anonymous: (body.anonymous as boolean | undefined) ?? false,
    title: string(body.title, 'title'),
    content: string(body.content, 'content'),
    category,
    latitude: number(body.latitude, 'latitude'),
    longitude: number(body.longitude, 'longitude'),
    radiusM: number(body.radiusM, 'radiusM'),
  };
}

export function commentEditInput(raw: unknown): string {
  const body = object(raw);
  fields(body, ['content']);
  return string(body.content, 'content');
}

export function commentInput(raw: unknown): string {
  const body = object(raw);
  fields(body, ['content', 'mediaIds', 'parentCommentId']);
  mediaIds(body.mediaIds);
  return string(body.content, 'content');
}

export function reactionInput(raw: unknown): PostReactionType {
  const body = object(raw);
  fields(body, ['type']);
  if (!Object.values(PostReactionType).includes(body.type as PostReactionType))
    throw new BadRequestException('Invalid reaction type');
  return body.type as PostReactionType;
}

export function reactionType(value: string): PostReactionType {
  if (!Object.values(PostReactionType).includes(value as PostReactionType))
    throw new BadRequestException('Invalid reaction type');
  return value as PostReactionType;
}

export function commentReactionInput(raw: unknown): CommentReactionType {
  const body = object(raw);
  fields(body, ['type']);
  return commentReactionType(body.type);
}

export function commentReactionType(value: unknown): CommentReactionType {
  if (
    !Object.values(CommentReactionType).includes(value as CommentReactionType)
  )
    throw new BadRequestException('Invalid comment reaction type');
  return value as CommentReactionType;
}

export function participantInput(raw: unknown): void {
  fields(object(raw), []);
}

export function commentId(value: string): string {
  if (!/^comment_[0-9a-f-]{36}$/.test(value))
    throw new BadRequestException('Invalid commentId');
  return value;
}

export function commentMediaInput(raw: unknown): string[] {
  return mediaIds(object(raw).mediaIds);
}

export function parentCommentInput(raw: unknown): string | null {
  const value = object(raw).parentCommentId;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('Invalid parentCommentId');
  return commentId(value);
}

function coverFocus(raw: unknown) {
  const value = object(raw);
  fields(value, ['x', 'y']);
  const x = number(value.x, 'coverFocus.x');
  const y = number(value.y, 'coverFocus.y');
  if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n <= 100))
    throw new BadRequestException(
      'coverFocus coordinates must be integers between 0 and 100',
    );
  return { x, y };
}

function displayPosition(raw: unknown) {
  const value = object(raw);
  fields(value, ['x', 'y']);
  const x = number(value.x, 'displayPosition.x');
  const y = number(value.y, 'displayPosition.y');
  if (![x, y].every(Number.isFinite))
    throw new BadRequestException(
      'displayPosition coordinates must be finite numbers',
    );
  return { x, y };
}
