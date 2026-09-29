export interface UserBadgesResponse {
  badges: {
    badgeId: string;
    code: string;
    name: string;
    description: string | null;
    imageKey: string | null;
    grantedAt: string;
  }[];
}
