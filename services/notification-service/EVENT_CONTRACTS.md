# Notification 이벤트와 정책

모든 stream의 XADD 필드는 eventId/eventType/data이며 eventId와 data 내부 ID가 일치해야 한다. Post는 eventType/schemaVersion, User는 type/version/target/payload, Moderation lifecycle은 payload, report는 data, AI 결과는 top-level을 검증한다. 다른 stream의 같은 ID는 다른 사건이다. 처리 receipt와 알림·배달 작업은 같은 PostgreSQL transaction에 저장한 후 XACK한다.

| Stream | Group | DLQ | 권위 |
| --- | --- | --- | --- |
| post:events | post-notification | notification:post:dead | Post 원본에 적용한 댓글/반응/투표/종료/삭제 |
| user:events | user-notification | notification:user:dead | User 칭호·레벨 확정 |
| moderation:events | moderation-notification | notification:moderation:dead | 버전이 있는 STALE/REACTIVATED 판단. CLOSED는 Post 적용 확인이 아님 |
| moderation:report-events | moderation-report-notification | notification:report:dead | 본인 신고 접수/취소 |
| moderation:content-events | moderation-content-notification | notification:content:dead | AI 관찰 receipt만, 제재/완료 알림 없음 |

`CONTENT_MODERATION_EVALUATED`는 `targetType`별로 검증한다. `POST`는 양의 안전 정수
`postVersion`, `COMMENT`는 비어 있지 않은 `commentId`가 필수다. 댓글의 `activityVersion`은
기존 계약대로 선택 필드다. targetType 누락·미지원 값과 필수 대상 정보 오류는 DLQ로 격리한다.
정상 결과는 flagged 값과 관계없이 PostgreSQL receipt를 저장하고 ACK하며 알림·Push를 만들지 않는다.
동일 eventId의 재전달은 receipt를 중복 저장하지 않는다. 게시물 검사 배포는 Notification 소비자,
Moderation, Post 생산자 순서로 진행한다.

## 알림함과 Push

- 댓글·답글·게시글/댓글 공감: 알림함+Push. 본인 행동 제외, User 권위 양방향 차단 검사. 종류별 기존 2분 묶음, 댓글 공감은 댓글·반응 종류별, 답글은 부모별. 게시글 작성자와 부모 작성자가 같으면 답글 한 건. 댓글 삭제/반응 취소는 기여분 차감과 tombstone, 부모 삭제는 자식 알림 취소. 본문/공개용 actor 신원은 푸시에 넣지 않는다.
- 후보: 게시글·후보 사용자당 한 알림+Push. 댓글별 fact는 따로 보존하며 같은 작성자의 후보 두 개를 두 번 알리지 않는다. 하나 삭제되어도 유효 후보가 남으면 유지. 승리는 별도 PostVoteWon만 사용하며 무승부/무효를 추정하지 않는다.
- User 획득/UP: 알림함+Push, 회수/DOWN: 알림함만, INITIAL/크레딧: receipt만. 본인 성과에는 사회 행동 자기제외가 없다. 칭호·지역·run·rank·score는 실제 payload만 저장하고 null 지역 이름을 생성하지 않는다. 정책/원장/랭킹 계산은 바꾸지 않는다.
- Moderation 새 lifecycle v1 선택 필드: payload.version(양의 정수), postAuthorId(decimal 문자열), scheduledCloseAt(실제 STALE 시각+기존10분, 다른 상태 null). 과거 v1도 파싱하지만 버전/예정 시각 없는 경고는 만들지 않는다. 실제 확인된 작성자에게만 STALE/재활성화 알림+Push. 지연되어 예정 시각이 지난 STALE은 알림함만. 재활성화/새 버전/실제 종료는 미전송 경고 취소. 참여자는 구독자로 취급하지 않는다.
- 실제 종료: PostExpired와 버전이 증가한 PostUpdated.closedAt 전이만 작성자에게 알림+Push. Post 삭제/만료는 과거 생성으로 부활하지 않는다. 수동 종료 후 재열림은 확정 버전으로 처리한다. 판단 stream CLOSED로 실제 종료를 알리지 않는다.
- 신고: REPORT_CREATED/WITHDRAWN은 신고자 알림함만. reportId/대상 종류만 노출한다. 현재 REVIEWED 관리자 명령/감사/조치 완료 생산자가 없으므로 검토 결과는 외부 계약 선행 필요다. AI flagged는 제재가 아니다.
- 제재: PostDeleted/PostCommentDeleted의 MODERATION actor와 MODERATION_VIOLATION 및 결정 ID가 검증된 실제 삭제만 콘텐츠 작성자에게 알림+Push. 신고자·신고 사유·AI 근거·삭제 본문은 반환하지 않는다.

모든 category 설정 false는 새 알림함과 Push를 모두 억제한다. 실제 Post가 있는 알림에는 게시글 mute도 적용한다. 설정은 Push 직전 다시 확인한다. User/신고처럼 Post가 없는 사건은 delivery.post_id=NULL이며 가짜 게시글을 만들지 않는다. 링크는 실제 post가 있으면 /posts/{id}, User·신고·삭제 안내는 /notifications다. 프런트에서 notificationId로 표시를 중복 제거한다. 외부 FCM 전송의 물리적 exactly-once는 보장하지 않는다.

새 User/Moderation group은 최초 배포 시 last-generated-id를 DB에 저장하고 그 이후부터 읽는다. 과거 재생은 명시적 startId로 별도 실행하며 원본 eventId를 유지한다. 이미 존재하는 group과 receipt는 보존한다. 자세한 운영 재처리·배포 순서는 운영 문서를 따른다.
# 주변 알림

Notification이 소유한 명시적 위치 구독은 기존 User 약관이나 Map의 게시글 GEO 후보와 별개다. Map에는 알림 동의를 포함한 사용자 위치 구독 계약이 없어 이를 조회/추정하지 않는다. 공개 API와 수신 정책은 [프런트 계약](../../docs/contracts/frontend-integration.md)을 따른다. 영속 fanout은 50명 페이지, 동시 User 조회5개, 60초 lease, 실패5초 후 재시도, cursor/게시글·사용자 business key로 복구한다. API 위치는 최대15분, PostCreated fanout도 발생 후15분 내로 제한한다. 만료 후 조회/발송이 차단되며 좌표 포함 행은 1분 주기/1000행 batch로 삭제한다. backlog가 있으면 다음 주기까지 남을 수 있어 만료 행 수를 감시한다. 완료·취소된 job 좌표도 정리하며 이벤트 receipt·알림에는 좌표를 저장하지 않는다.
