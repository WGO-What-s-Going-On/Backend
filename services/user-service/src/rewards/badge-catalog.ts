import type { EntityManager } from 'typeorm';
export const BADGE_CATALOG = [
  {
    code: 'NEWS_SOURCE',
    name: '소식통',
    description:
      '누적 유효 참여 10회. 단순 입장 이벤트는 중복 집계하지 않습니다.',
  },
  {
    code: 'REPORTER',
    name: '리포터',
    description: '맞아요(AGREE)를 각각 10개 이상 받은 서로 다른 댓글 10개.',
  },
  {
    code: 'CORRESPONDENT',
    name: '특파원',
    description: '서로 다른 게시물의 대표 의견으로 유효 선정 5회.',
  },
  {
    code: 'CLAIRVOYANT',
    name: '천리안',
    description:
      '행정동별 최근 30일 대표 의견 실적이 있는 특파원 10명 이상 중 상위 10%.',
  },
] as const;
export async function seedBadgeCatalog(manager: EntityManager): Promise<void> {
  // Preserve existing administrator changes and every existing badge assignment.
  for (const b of BADGE_CATALOG)
    await manager.query(
      `INSERT INTO badges(code,name,description,image_key,active,created_at)
    VALUES($1,$2,$3,NULL,true,now()) ON CONFLICT(code) DO NOTHING`,
      [b.code, b.name, b.description],
    );
}
