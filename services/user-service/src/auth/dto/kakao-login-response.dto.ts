export interface KakaoLoginResponse {
  userId: string;
  isNewUser: boolean;
  onboardingRequired: boolean;
  restoredFromWithdrawal: boolean;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
