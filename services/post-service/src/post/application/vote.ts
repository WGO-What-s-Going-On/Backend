import { event } from './event.js';
import type { PostTransaction } from './ports.js';

export interface VoteCandidate {
  commentId: string;
  content: string;
  scoreAtSelection: number;
  votes: number;
}

export interface VoteState {
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'NONE';
  candidates: VoteCandidate[];
  selectedAt: Date | null;
  closedAt: Date | null;
  winner: VoteCandidate | null;
}

export class VoteUnavailableError extends Error {}

// 종료 경로와 관계없이 승자 확정과 이벤트를 함께 커밋한다.
export async function closeVote(
  tx: PostTransaction,
  postId: string,
  now: Date,
) {
  const vote = await tx.commands.closeVote(postId, now);
  if (vote)
    await tx.commands.appendEvent(
      event(postId, 'PostVoteWon', { vote, activityVersion: 1 }, now),
    );
}
