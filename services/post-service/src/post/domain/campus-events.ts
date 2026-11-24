// This one-off campaign is deliberately limited to these two reserved identities.
export const CAMPUS_POLICY = 'CAU_CAMPUS_2026_30D' as const;
export const CAMPUS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const CAMPUS_POST_IDS = [
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2031',
  'post_3b16ea1a-4de6-4a2c-85be-56a64ada2032',
] as const;
export function isCampusEvent(post: {
  postId: string;
  lifecyclePolicy?: unknown;
}): boolean {
  return (
    post.lifecyclePolicy === CAMPUS_POLICY &&
    CAMPUS_POST_IDS.some((id) => id === post.postId)
  );
}
export const CAMPUS_CONTENT = [
  {
    title: '🔥 [WGO 캠퍼스 챌린지] 중앙대 학과 대항전',
    content:
      '우리 학과가 제일 빡센 이유를 증명하라!\n\n시험, 과제, 팀플, 밤샘, 실험까지…\n\n중앙대에서 가장 빡센 학과는 어디일까요?\n\n댓글에 학과 이름과 우리 학과가 빡센 이유를 남겨주세요!\n\n다른 학과의 주장도 구경하고, 공감되는 댓글에 반응해 보세요.\n\n과연 어떤 학과가 가장 많은 공감을 받을까요? 👀',
  },
  {
    title: '🗿 [WGO 캠퍼스 챌린지] 중앙대 고인물 인증 대회',
    content:
      '이거 알면 진짜 중앙대 고인물 인정!\n\n중앙대에 오래 다닌 사람만 아는 장소, 꿀팁, 전설 같은 이야기 있나요?\n\n남들은 잘 모르는 중앙대 TMI를 댓글로 알려주세요.\n\n"아 이걸 안다고?" 싶은 댓글에는 공감을!\n\n누가 진정한 중앙대 고인물인지 확인해 봅시다. 🗿',
  },
] as const;
