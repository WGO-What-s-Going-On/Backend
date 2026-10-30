export interface GrowthResponse {
  titles: import('./title.service.js').TitleProgress;
  credits: string;
  growthScore: string;
  level: number | null;
  policyVersion: string | null;
  rewardsEnabled: boolean;
  levelFloor: string | null;
  nextLevelScore: string | null;
}

export interface CreditHistoryItem {
  id: string;
  activityKey: string;
  eventId: string;
  policyVersion: string;
  delta: string;
  growthDelta: string;
  createdAt: string;
}

export interface CreditHistoryResponse {
  items: CreditHistoryItem[];
  nextCursor: string | null;
}
