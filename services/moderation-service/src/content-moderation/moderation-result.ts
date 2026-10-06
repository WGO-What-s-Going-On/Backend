export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  model: string;
}

export interface StoredModerationResult extends ModerationResult {
  eventId: string;
  postId: string;
  commentId: string;
  moderatedAt: string;
}
