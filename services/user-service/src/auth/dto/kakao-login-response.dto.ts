export interface KakaoLoginResponse {
  userId: string;
  isNewUser: boolean;
  onboardingRequired: boolean;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
