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
