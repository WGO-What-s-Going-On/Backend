import type { PoolClient } from 'pg';
import type { PostEvent } from '../event-consumer/post-event.js';
import { NotificationEventWriter } from './notification-event.writer.js';

interface Fact {
  activity_key: string;
  version: number;
  active: boolean;
  terminal: boolean;
  notification_id: string | null;
  recipient: string | null;
  details: Record<string, string>;
}
export async function subtractFact(client: PoolClient, fact: Fact) {
  if (!fact.active || !fact.notification_id || !fact.recipient) return;
  const candidate = fact.details.kind === 'candidate';
  const remaining =
    candidate &&
    (
      await client.query(
        `SELECT 1 FROM notification_activities
    WHERE post_id=$1 AND activity_key<>$2 AND active AND notification_id=$3 LIMIT 1`,
        [fact.details.postId, fact.activity_key, fact.notification_id],
      )
    ).rowCount;
  if (remaining) return;
  await client.query(
    `UPDATE notifications SET count=GREATEST(0,count-1)
    WHERE user_id=$1 AND notification_id=$2`,
    [fact.recipient, fact.notification_id],
  );
  await client.query(
    `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL
    WHERE message->'data'->>'notificationId'=$1 AND status IN ('PENDING','SENDING')
    AND NOT EXISTS(SELECT 1 FROM notifications WHERE user_id=$2 AND notification_id=$1 AND count>0)`,
    [fact.notification_id, fact.recipient],
  );
}

// All calls run under the same post row lock as legacy activity grouping.
export async function projectExtendedPost(
  client: PoolClient,
  event: PostEvent,
  post: { closed: boolean; paused: boolean },
  writer: NotificationEventWriter,
  allowed: Set<string> | undefined,
  now: Date,
): Promise<boolean> {
  const postId = event.aggregateId,
    type = event.eventType,
    commentId = event.commentId;
  const commentEvent = [
    'PostCommentCreated',
    'PostCommentUpdated',
    'PostCommentDeleted',
  ].includes(type);
  if (commentId && event.commentAuthorId) {
    const known = (
      await client.query(
        'SELECT author_id FROM notification_comment_states WHERE post_id=$1 AND comment_id=$2',
        [postId, commentId],
      )
    ).rows[0];
    if (known?.author_id && known.author_id !== event.commentAuthorId)
      throw new Error('Invalid immutable comment author conflict');
  }
  if (event.parentCommentId && event.parentCommentAuthorId) {
    const parent = (
      await client.query(
        'SELECT author_id FROM notification_comment_states WHERE post_id=$1 AND comment_id=$2',
        [postId, event.parentCommentId],
      )
    ).rows[0];
    if (parent?.author_id && parent.author_id !== event.parentCommentAuthorId)
      throw new Error('Invalid parent author conflict');
  }
  if (commentEvent && commentId) {
    await client.query(
      `INSERT INTO notification_comment_states(post_id,comment_id,version,deleted,author_id,parent_comment_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(post_id,comment_id) DO UPDATE SET
      version=GREATEST(notification_comment_states.version,EXCLUDED.version),
      deleted=notification_comment_states.deleted OR EXCLUDED.deleted,
      author_id=COALESCE(notification_comment_states.author_id,EXCLUDED.author_id),
      parent_comment_id=COALESCE(notification_comment_states.parent_comment_id,EXCLUDED.parent_comment_id)`,
      [
        postId,
        commentId,
        event.activityVersion ?? 1,
        type === 'PostCommentDeleted',
        event.commentAuthorId ?? event.actorId,
        event.parentCommentId ?? null,
      ],
    );
  }
  if (type === 'PostCommentDeleted') {
    const facts = (
      await client.query<Fact>(
        `SELECT * FROM notification_activities WHERE post_id=$1 AND active
      AND (details->>'commentId'=$2 OR details->>'parentCommentId'=$2)`,
        [postId, commentId],
      )
    ).rows;
    // Mark each fact before counting remaining candidate references.
    for (const fact of facts) {
      await client.query(
        `UPDATE notification_activities SET active=false,terminal=true WHERE post_id=$1 AND activity_key=$2`,
        [postId, fact.activity_key],
      );
      await subtractFact(client, fact);
    }
    return false; // legacy top-level comment contributions still need their tombstone.
  }
  const reply = type === 'PostCommentCreated' && !!event.parentCommentId;
  const reaction = [
    'PostCommentReactionCreated',
    'PostCommentReactionRemoved',
  ].includes(type);
  const candidate = type === 'PostVoteCandidateSelected',
    won = type === 'PostVoteWon';
  if (!reply && !reaction && !candidate && !won)
    return type === 'PostCommentUpdated';
  const deleted = (
    await client.query(
      `SELECT 1 FROM notification_comment_states WHERE post_id=$1
    AND comment_id=ANY($2::text[]) AND deleted LIMIT 1`,
      [postId, [commentId, event.parentCommentId].filter(Boolean)],
    )
  ).rowCount;
  const active =
    type !== 'PostCommentReactionRemoved' &&
    !deleted &&
    (won || (!post.closed && !post.paused));
  const recipients = reply
    ? [
        ...new Set(
          [event.postAuthorId, event.parentCommentAuthorId].filter(
            (id): id is string => !!id,
          ),
        ),
      ]
    : [event.commentAuthorId!];
  if (reply && !event.parentCommentAuthorId)
    throw new Error(
      'Parent comment author unavailable; reconcile producer context',
    );
  for (const recipient of recipients) {
    const key = reply
      ? `reply#${commentId}#${recipient}`
      : reaction
        ? `comment-reaction#${commentId}#${event.actorId}#${event.reactionType}`
        : candidate
          ? `candidate#${commentId}`
          : `winner#${event.resultId}`;
    const previous = (
      await client.query<Fact>(
        'SELECT * FROM notification_activities WHERE post_id=$1 AND activity_key=$2',
        [postId, key],
      )
    ).rows[0];
    const version = event.activityVersion ?? 1;
    if (previous && (previous.terminal || version <= previous.version))
      continue;
    if (
      previous &&
      reaction &&
      previous.recipient &&
      previous.recipient !== recipient
    )
      throw new Error('Comment reaction identity changed');
    let notificationId: string | null = null;
    const social = reply || reaction;
    if (!active) {
      if (previous) await subtractFact(client, previous);
    } else if (
      !event.suppressNotifications &&
      (!social || recipient !== event.actorId) &&
      (!social || !allowed || allowed.has(recipient))
    ) {
      const kind = reply
        ? 'COMMENT_REPLIED'
        : reaction
          ? 'COMMENT_REACTED'
          : candidate
            ? 'VOTE_CANDIDATE_SELECTED'
            : 'VOTE_WON';
      const written = await writer.write(
        client,
        {
          stream: 'post:events',
          eventId: event.eventId,
          userId: recipient,
          postId,
          businessKey: candidate
            ? `candidate:${postId}:${recipient}`
            : won
              ? `winner:${postId}:${recipient}`
              : `${key}:${version}`,
          type: kind,
          title: reply
            ? '새 답글'
            : reaction
              ? '댓글 공감'
              : candidate
                ? '투표 후보 선정'
                : '투표 승리',
          body: reply
            ? '댓글에 새 답글이 달렸습니다.'
            : reaction
              ? '댓글에 새로운 반응이 있습니다.'
              : candidate
                ? '댓글이 투표 후보로 선정되었습니다.'
                : '댓글이 투표에서 선정되었습니다.',
          category: reply ? 'replies' : reaction ? 'reactions' : 'votes',
          push: true,
          commentId: commentId!,
          allowTerminal: won,
          ...(social && event.actorId ? { actorId: event.actorId } : {}),
          ...(event.parentCommentId
            ? { parentCommentId: event.parentCommentId }
            : {}),
          ...(social
            ? {
                bundleKey: reply
                  ? `reply:${event.parentCommentId}`
                  : `comment-reaction:${commentId}:${event.reactionType}`,
              }
            : {}),
          metadata: {
            ...(event.reactionType ? { reactionType: event.reactionType } : {}),
            ...(event.regionCode !== undefined
              ? { regionCode: event.regionCode }
              : {}),
            ...(event.resultId ? { resultId: event.resultId } : {}),
          },
        },
        now,
      );
      notificationId = written?.notificationId ?? null;
    }
    await client.query(
      `INSERT INTO notification_activities(post_id,activity_key,version,active,terminal,notification_id,recipient,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(post_id,activity_key) DO UPDATE SET version=EXCLUDED.version,
      active=EXCLUDED.active,terminal=EXCLUDED.terminal,notification_id=EXCLUDED.notification_id,recipient=EXCLUDED.recipient,details=EXCLUDED.details`,
      [
        postId,
        key,
        version,
        !!active,
        !!deleted,
        notificationId,
        recipient,
        {
          postId,
          commentId,
          parentCommentId: event.parentCommentId,
          actorId: event.actorId,
          kind: candidate
            ? 'candidate'
            : won
              ? 'winner'
              : reply
                ? 'reply'
                : 'commentReaction',
        },
      ],
    );
  }
  return true;
}
