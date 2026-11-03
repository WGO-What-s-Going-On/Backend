# Notification 구현 매트릭스

기준: feat/notification-user-events 시작 HEAD cd8e9e9, 실제 생산/소비 코드 조사.

| 기능 | 시작 상태 | 이번 범위 / 권위 사건 | 수신자 |
| --- | --- | --- | --- |
| 게시글 댓글 | 이미 구현 | post:events / PostCommentCreated, 기존 2분 묶음 유지 | postAuthorId |
| 답글 | 이번 구현 | Post에 parentCommentId는 있으나 부모 작성자 wire 없음: 최소 문맥 확장 | 확인된 부모 작성자, 게시글 작성자와 중복 제거 |
| 게시글 공감 | 이미 구현 | PostReactionCreated/Removed, 2분 묶음/버전/취소 유지 | postAuthorId |
| 댓글 공감 | 이번 구현 | 실제 PostCommentReactionCreated/Removed | commentAuthorId |
| 투표 후보/승리 | 이번 구현 | PostVoteCandidateSelected와 PostVoteWon은 별도 사실 | 후보/승리 댓글 작성자 |
| 주변 새 글 | 이번 구현 | PostCreated + Notification 소유 명시적 위치 구독, 150m | opt-in·위치 동의·신선한 좌표·차단 검사 통과 사용자 |
| 종료 예정/재활성화 | 이번 구현 | moderation:events의 확정 lifecycle 전이. 버전/예정 시각 계약 보강 | 확인된 게시글 작성자만, 참여자를 구독자로 추정하지 않음 |
| 실제 종료 | 이번 구현 | Post가 적용 후 발행한 PostExpired 또는 PostUpdated의 확정 닫힘 | 확인된 게시글 작성자 |
| 칭호/레벨 | 이번 구현 | user:events의 User envelope, 전용 user-notification | target/payload로 검증된 해당 사용자 |
| 신고 접수/취소 | 이번 구현 | moderation:report-events / REPORT_CREATED, REPORT_WITHDRAWN | reporterUserId, 알림함만 |
| 신고 처리 완료 | 외부 계약 선행 필요 | 현재 REVIEWED enum만 있고 검토 명령·결정/조치 완료 생산자 없음 | 실제 검토/조치 확정 이벤트 도입 후 신고자 |
| 확정 콘텐츠 제재 | 이번 구현 | 실제 PostDeleted/PostCommentDeleted의 MODERATION actor + MODERATION_VIOLATION | 삭제 적용된 콘텐츠 작성자 |
| AI 평가 결과 | 알림 생성 안 함 | moderation:content-events / CONTENT_MODERATION_EVALUATED는 제재 확정 아님 | 처리 receipt만, 대상에게 제재/완료 알림 금지 |
| 실시간 WS | 외부 계약 선행 필요 | 현재 인증된 사용자 Notification 채널 없음 | REST 알림함/FCM 유지, 공개 브로드캐스트 사용 금지 |

Post의 댓글 본문·익명 작성자 신원·신고 사유는 다른 사용자에게 노출하지 않는다.
User 칭호/랭킹 정책과 원장은 수정하지 않는다. 동일 사건을 판단 Stream과 적용 Stream에서 두 번 알리지 않는다.
최종 알림함/FCM/설정/취소 정책 및 검증 결과는 완료 보고서에서 구분한다.
