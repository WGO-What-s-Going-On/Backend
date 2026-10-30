export const TITLE_SETTINGS = Symbol('TITLE_SETTINGS');
export interface TitleSettings {
  enabled: boolean;
  regionalRankingEnabled: boolean;
  regionContract: 'none' | 'post-region-v1';
}
export const TITLE_POLICY = {
  version: 'wgo-titles-v1',
  participation: 10,
  agreesPerComment: 10,
  reporterComments: 10,
  representativeWins: 5,
  windowDays: 30,
  minimumCompetitors: 10,
  selectedFraction: 'floor(N/10)',
  timeZone: 'Asia/Seoul',
  tieBreak: 'score DESC, last_selected_at ASC, user_id ASC',
  retainExpired: true,
  excludeDeleted: true,
  excludeInactiveAccounts: true,
} as const;
export const TITLE_CODES = [
  'NEWS_SOURCE',
  'REPORTER',
  'CORRESPONDENT',
  'CLAIRVOYANT',
] as const;
export function loadTitleSettings(
  env: NodeJS.ProcessEnv = process.env,
): TitleSettings {
  const flag = (key: string, fallback: boolean) => {
    const value = env[key];
    if (value === undefined || value === '') return fallback;
    if (value !== 'true' && value !== 'false')
      throw new Error(`${key} must be true or false`);
    return value === 'true';
  };
  const contract = env.USER_TITLE_REGION_CONTRACT ?? 'none';
  if (contract !== 'none' && contract !== 'post-region-v1')
    throw new Error('Unsupported User title region contract');
  return {
    enabled: flag('USER_TITLES_ENABLED', true),
    regionalRankingEnabled: flag('USER_REGIONAL_RANKING_ENABLED', true),
    regionContract: contract,
  };
}
// Use an explicit +09:00 boundary; this does not depend on the server's local zone.
export function rankingWindow(now: Date) {
  const date = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const end = new Date(`${date}T00:00:00+09:00`);
  return {
    date,
    start: new Date(end.getTime() - TITLE_POLICY.windowDays * 86400000),
    end,
    next: new Date(end.getTime() + 86400000),
  };
}
