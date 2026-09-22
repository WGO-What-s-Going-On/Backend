import type { UserStatus } from '../../database/entities/user.entity.js';

export interface UserProfileResponse {
  userId: string;
  nickname: string;
  profileImageKey: string | null;
  status: UserStatus;
  onboardingRequired: boolean;
  createdAt: string;
}

export interface UpdateUserProfile {
  nickname?: string;
  profileImageKey?: string | null;
}
