export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  model: string;
}

interface StoredResult extends ModerationResult {
  eventId: string;
  postId: string;
  moderatedAt: string;
  correlationId?: string;
  authorId?: number;
  sourceHash?: string;
}

export type StoredModerationResult = StoredResult &
  (
    | {
        targetType: 'POST';
        postVersion: number;
        commentId?: never;
        activityVersion?: never;
      }
    | {
        // Results stored before post evaluation had no target discriminant.
        targetType?: 'COMMENT';
        commentId: string;
        activityVersion?: number;
        postVersion?: never;
      }
  );
