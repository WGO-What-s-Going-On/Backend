import type { UserStatus } from '../../database/entities/user.entity.js';

export interface UserProfileResponse {
  realName: string | null;
  userId: string;
  nickname: string;
  profileImageKey: string | null;
  status: UserStatus;
  onboardingRequired: boolean;
  createdAt: string;
}

export interface UpdateUserProfile {
  realName?: string | null;
  nickname?: string;
  profileImageKey?: string | null;
}
