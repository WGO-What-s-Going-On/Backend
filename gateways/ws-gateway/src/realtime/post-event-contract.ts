export interface PostRealtimeMessage {
  version: 1;
  type:
    | 'comment.created'
    | 'comment.deleted'
    | 'post.updated'
    | 'post.created'
    | 'post.deleted'
    | 'post.expired'
    | 'post.reaction.created'
    | 'post.participant.joined';
  eventId: string;
  postId: string;
  boardId: string;
  occurredAt: string;
  postVersion?: number;
  activityVersion?: number;
  comment?: Record<string, unknown>;
  deletedAt?: string;
  expiredAt?: string;
  closedAt?: string | null;
}
export class InvalidPostEvent extends Error {}
const types: Record<string, PostRealtimeMessage['type']> = {
  PostUpdated: 'post.updated',
  PostCreated: 'post.created',
  PostDeleted: 'post.deleted',
  PostExpired: 'post.expired',
  PostCommentCreated: 'comment.created',
  PostCommentDeleted: 'comment.deleted',
  PostReactionCreated: 'post.reaction.created',
  PostParticipantJoined: 'post.participant.joined',
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;
const date = (v: unknown): v is string =>
  text(v) && Number.isFinite(Date.parse(v));
function version(v: unknown): number {
  // 과거 v1 생성 이벤트에는 상태 버전이 없으므로 기존 계약의 기본값 1을 사용한다.
  if (v === undefined) return 1;
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    throw new InvalidPostEvent('Invalid resource version');
  return Number(v);
}
export function realtimePostEvent(
  fields: Record<string, string>,
): PostRealtimeMessage | null {
  if (fields.eventType && !Object.hasOwn(types, fields.eventType)) return null;
  try {
    if (!fields.data || Buffer.byteLength(fields.data) > 65536)
      throw new Error();
    const value: unknown = JSON.parse(fields.data);
    if (
      !object(value) ||
      !text(value.eventType) ||
      !Object.hasOwn(types, value.eventType) ||
      value.eventType !== fields.eventType ||
      value.eventId !== fields.eventId ||
      !text(value.eventId) ||
      !text(value.aggregateId) ||
      value.producer !== 'post-service' ||
      value.schemaVersion !== 1 ||
      !date(value.occurredAt)
    )
      throw new Error();
    const message: PostRealtimeMessage = {
      version: 1,
      type: types[value.eventType]!,
      eventId: value.eventId,
      postId: value.aggregateId,
      boardId: value.aggregateId,
      occurredAt: value.occurredAt,
    };
    if (
      message.type === 'comment.created' ||
      message.type === 'comment.deleted'
    ) {
      const comment = value.comment;
      if (
        !object(comment) ||
        comment.postId !== message.postId ||
        !text(comment.commentId)
      )
        throw new Error();
      message.activityVersion = version(value.activityVersion);
      if (message.type === 'comment.deleted') {
        if (!date(comment.deletedAt)) throw new Error();
        // 삭제된 본문과 내부 제재 정보는 클라이언트로 전달하지 않는다.
        message.comment = {
          postId: message.postId,
          commentId: comment.commentId,
          deletedAt: comment.deletedAt,
        };
      } else {
        if (
          typeof comment.content !== 'string' ||
          comment.content.length > 2000 ||
          !date(comment.createdAt)
        )
          throw new Error();
        message.comment = comment;
      }
    }
    if (message.type === 'post.updated') {
      if (
        !object(value.post) ||
        value.post.postId !== message.postId ||
        !(value.post.closedAt === null || date(value.post.closedAt))
      )
        throw new Error();
      message.postVersion = version(value.postVersion);
      message.closedAt = value.post.closedAt as string | null;
    }
    if (message.type === 'post.deleted' || message.type === 'post.expired') {
      if (!object(value.post) || value.post.postId !== message.postId)
        throw new Error();
      const field = message.type === 'post.deleted' ? 'deletedAt' : 'expiredAt';
      if (!date(value.post[field])) throw new Error();
      message[field] = value.post[field];
      message.postVersion = version(value.postVersion);
    }
    return message;
  } catch {
    throw new InvalidPostEvent('Invalid supported Post event');
  }
}
