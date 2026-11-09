import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { OpenAiModerationAdapter } from '../../src/content-moderation/openai-moderation.adapter.js';

// Synthetic fixtures only. Neither these texts nor SDK errors are printed.
const cases = [
  ['normal', '오늘 날씨가 좋네요. 모두 좋은 하루 보내세요.'],
  ['profanity', '아 씨발, 버스를 놓쳤네.'],
  ['directed-profanity', '너는 진짜 병신 같은 새끼야. 꺼져.'],
  ['threat', '너를 찾아가서 칼로 찔러 죽여버리겠다.'],
  ['violence', '그 사람의 얼굴을 주먹으로 때리고 발로 짓밟았다.'],
  ['obfuscated-profanity', '너 진짜 ㅂㅅ이네. ㅅㅂ 꺼져.'],
  [
    'safety-context',
    '누군가 위협하면 맞서 싸우지 말고 안전한 장소로 피하세요.',
  ],
] as const;

it.skipIf(!process.env.OPENAI_API_KEY)(
  'records live Korean category signals without inventing an enforcement policy',
  async () => {
    const adapter = new OpenAiModerationAdapter(
      new ConfigService({ openai: { apiKey: process.env.OPENAI_API_KEY } }),
    );
    let failures = 0;
    for (const [caseId, content] of cases) {
      try {
        const result = await adapter.moderate(content);
        expect(typeof result.flagged).toBe('boolean');
        expect(Object.keys(result.categories).length).toBeGreaterThan(0);
        // A coverage observation, not a brittle assertion that profanity must
        // map to harassment or that every flagged sentence should be removed.
        process.stdout.write(`${JSON.stringify({ caseId, ...result })}\n`);
      } catch {
        failures++;
        process.stdout.write(
          `${JSON.stringify({ caseId, status: 'UNAVAILABLE' })}\n`,
        );
      }
    }
    expect(failures, 'Live requests unavailable; SDK details suppressed').toBe(
      0,
    );
  },
);
