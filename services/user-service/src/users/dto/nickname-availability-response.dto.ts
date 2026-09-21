export type NicknameUnavailableReason = 'DUPLICATED' | 'PROHIBITED';

export interface NicknameAvailabilityResponse {
  available: boolean;
  reason: NicknameUnavailableReason | null;
}
