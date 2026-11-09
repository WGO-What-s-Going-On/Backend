# 외부 연동 조사와 계약 요청

최초 조사 2026-10-15, lifecycle v1 수신 연결 상태 갱신 2026-10-24. 기존 구현과 사용자가 확정한 ENDED 스냅샷 정책을 반영합니다. 아래 신규 계약 제안은 구현된 외부 이벤트가 아닙니다. 기존 lifecycle v1의 Post 수신 연결은 별도로 구현 상태를 명시합니다.

## 확인한 기준

- dev `07769a20c3f95f547c83f73025f4ffd9fc43974f`: [Post 이벤트](../../post-service/contracts/post-events.md), [댓글 공감](../../post-service/contracts/comment-vote.md), `post/infrastructure/post-event-envelope.ts`, `post/application/commands.ts`, `lifecycle.ts`, `post.controller.ts`, `presentation/service-auth.ts`, `infrastructure/operations.cli.ts`.
- [내부 서비스 인증 권한표](../../../docs/contracts/service-authentication.md).
- Notification 별도 작업 브랜치 `feat/notification-service-구현` `e159626`: README, `src/event-consumer/post-event.ts`, `post-event.handler.ts`, persistence 처리. 현재 Moderation 브랜치의 Notification을 새 구현으로 간주하지 않는다.
- Map `src/post-consumer.ts`, `post-index.ts`; WS Gateway `src/realtime/post-events.ts`, `post-client.ts`.
- [Notion Lifecycle 설계](https://app.notion.com/p/3ec33f226af781c2a7d0d792c55f4da1), [Post 연동 현황](https://app.notion.com/p/3fa33f226af780b4b3b2f31afc8b47e2). 유예는 최신 확정 10분을 사용하며 window 재평가는 사용자 선택에 따라 고정 snapshot으로 보완했다.

## 게시글 본문 검사

2026-11-09에 Post 이벤트의 스냅샷 방식으로 연결했다. 신규 `PostCreated`와 제목·본문
수정 `PostUpdated`는 `post.title`, `post.content`, `post.authorId`, 최상위 `postVersion`을
같은 MongoDB 트랜잭션에 저장한다. Moderation은 제목과 본문을 검사하고 원본 버전을
`moderation:content-events`의 POST 결과에 보존한다. 인가된 상세 조회나 다른 서비스 DB 접근은 필요하지 않다.

종료·재개만 한 이벤트와 과거 본문 없는 이벤트는 내용을 추정하지 않고 검사를 생략한다.
과거 글의 소급 검사와 자동 제재는 별도 작업이다. 중복·재발행과 배포 순서는
[내용 검사 이벤트 계약](content-moderation-events.md)을 따른다.

## 콘텐츠 제재 결정

현재 게시글·댓글 결과는 Moderation Redis에 저장하고 moderation:content-events에 CONTENT_MODERATION_EVALUATED v1로 발행한다. 검사 결과는 확정 제재 결정과 다르다. `CONTENT_MODERATION_DECIDED`의 합의된 wire/수신 consumer와 자동 조치 API가 없다. Post의 운영 CLI에서 검토된 moderationDecisionId를 사용해 삭제하는 기능이 있다는 사실은 네트워크 결정 소비 계약이 있다는 뜻이 아니다. flagged만으로 자동 삭제하지 않는다.

합의할 결정 event 또는 command에는 다음이 필요하다.

- 고유 eventId와 안정적인 moderationDecisionId, producer/schemaVersion, occurredAt/correlationId.
- targetType POST/COMMENT, postId/targetId, sourceEventId, 검사한 contentVersion/hash.
- 결정 enum과 policyVersion/reason, 모델·근거의 허용 범위. 모델 flagged와 실제 조치 결정을 구분.
- Post의 멱등 적용, 대상 버전 CAS, 이미 삭제된 대상 처리, 영구 거부·일시 장애와 재전송 규칙.
- 적용 성공/거부 확정 이벤트. USER/MODERATION actor, reason, moderationDecisionId를 Post가 원본 삭제 이벤트에 반영.

댓글 검사 중 삭제된 경우 현재 구현은 결과를 감사 근거로 보존하고 활동 반영을 막는다. 결과의 30일 보존 이후까지 감사가 필요하면 별도 영속 보존 계약이 필요하다.

## Lifecycle 실제 적용

Moderation은 기존 v1 `moderation:events`에 BOARD_STALE / BOARD_REACTIVATED / BOARD_CLOSED를 발행한다. 2026-10-24 Post에 opt-in Consumer를 연결했다. STALE/REACTIVATED는 처리 이력만 남기고, CLOSED는 사용자가 확정한 정책에 따라 ACTIVE → EXPIRED로 적용한다. Post 원본 상태는 ACTIVE/EXPIRED/DELETED로 Moderation의 ACTIVE/STALE/CLOSED와 다르다. 이번 연결은 CLOSED → EXPIRED 매핑을 사용하며 상세 종료 사유는 후속 계약으로 남긴다.

Post의 기본 수신·적용 계약은 [Post 이벤트 문서](../../post-service/contracts/post-events.md#11-moderation-lifecycle-v1-수신-2026-10-24)를 따른다. 다음 확장은 아직 미구현이다.

1. 결정 ID, 게시물 ID, lifecycle decision version, expected Post version, decidedAt, reason과 필요한 근거.
2. STALE/REACTIVATED의 원본 상태/가시성 의미와 CLOSED의 실제 상태 매핑. 이미 DELETED/EXPIRED인 경우의 거부·무시 규칙.
3. 중복·역순 결정의 CAS와 원본 변경 + 확정 event/outbox의 원자성.
4. Post 상태 적용 성공/거부 이벤트, postVersion, 원인 결정 ID와 수신자에게 공개 가능한 종료 예정/확정 시각.

output v1에는 Notification 연동을 위해 선택적인 projection version/postAuthorId/scheduledCloseAt을 추가했다. 필수 envelope는 유지하며 ENDED snapshot/원본 expected Post version은 이 확장에 포함하지 않는다. Notification은 version으로 역순을 제어하고 실제 종료는 Post 적용 이벤트로만 확정한다. 상세 계약은 [Notification 이벤트](../../notification-service/EVENT_CONTRACTS.md)를 따른다.

## ENDED 집계의 완결성 경계

관계별 activityVersion은 종류 간 최신성을 결정하지 못한다. 현재 구현은 종류별 상태를 보존하고 다중 활성 사용자가 있으면 조기 종료를 보류한다. 수신한 이벤트의 중복·역순 및 동시 CAS 결과는 보호하지만, 아직 도착하지 않은 취소/활동을 알아낼 수는 없다. 모든 event-time 활동이 반영된 뒤 CLOSED를 확정하려면 다음 중 하나가 필요하다.

- `(postId,userId)` 전체 공감 전이 버전과 기존/새 종류를 함께 제공하는 변경 이벤트 및 재생 기준.
- 인가된 현재 활성 공감 snapshot API: snapshotVersion/기준 시각, 활성 관계와 관계 버전, pagination 중 일관성 보장.
- 원본 outbox의 게시물별 순서/완료 watermark 또는 명시적 지연 한도. snapshot 이후의 event cursor와 증분 적용 규칙.

이 계약 전에는 무한 지연 이벤트까지 포함하는 전역 완결성이나 CLOSED 이후 재개방을 보장하지 않는다. 이력 누락을 감지한 기존 projection에는 새 10분 window가 확보될 때까지 조기 종료를 보류한다.

## Notification

Notification은 Post 확장 활동과 User/Moderation 전용 stream/group을 소비한다. STALE/REACTIVATED는 실제 버전·예정 시각과 확인된 작성자를 사용하며 BOARD_CLOSED는 receipt/대기 경고 취소만 수행한다. ParticipantJoined는 알림 수신 동의가 아니다.

실제 종료는 PostExpired/PostUpdated의 적용 상태와 버전으로 알린다. 수신자는 확인된 작성자로 한정하며 동의한 참여자 목록 계약은 없다. 제재는 PostDeleted/PostCommentDeleted의 실제 MODERATION 삭제 적용만 사용하고 AI flagged나 신고 접수로 조치 완료를 추정하지 않는다. [현재 매트릭스](../../notification-service/NOTIFICATION_MATRIX.md)와 [운영 절차](../../notification-service/OPERATIONS.md)를 참조한다.

## Map / Realtime

Map은 실제 PostDeleted/PostExpired를 소비해 index에서 제외한다. Moderation BOARD_CLOSED를 소비하지 않으므로 Post 원본 상태 적용이 선행되어야 한다.

WS Gateway는 참가 시 Post status가 ACTIVE인지 확인한다. 2026-10-25 dev에는 PostDeleted/PostExpired/PostCommentDeleted 전달과 Room 정리가 추가되어 있다. 기존 4종만 처리한다는 설명은 대체한다. Moderation은 Gateway socket을 직접 제어하지 않으며 실제 Post 적용 결과를 따라야 한다.

## Issue #31 범위

이 서비스 내부의 9종 소비, 활동/ENDED 판단, 삭제·만료, Redis 정합성 및 검증은 구현했다. 게시글 내용 검사는 연결했다. 콘텐츠 제재/종료 알림의 종단 간 연동은 별도 계약이다. 기존 lifecycle v1의 Post 종료 적용은 별도 opt-in Consumer로 연결했으며 버전·사유 등 확장 계약은 후속이다. Issue 전체를 완료로 닫지 않으며 사용자 확인 없이 PR을 생성하지 않는다.


## Lifecycle v1 연결 이후 후속 작업

이번 작업은 기존 생산 이벤트를 그대로 소비한다. 아래 항목은 의도적으로 범위에서 제외했다.

1. **순서 버전**: projection.version을 이벤트에 노출할지 결정한다. 내부 활동 갱신에도 증가하므로
   연속 번호 누락을 곧바로 유실로 해석하지 않는다. Post가 유예 상태를 복제할 때 역순 방어가 필요하다.
2. **종료 사유**: INACTIVITY/ENDED를 이벤트와 Post 원본에 전달하고 자연 만료와 구분한다.
   현재는 sourceEventId로 발행 원인을 추적할 수 있지만 상세 사유는 복원하지 않는다.
3. **최신 활동과 판단의 차이**: 현재 Post는 CLOSED 판단 뒤 새 활동이 있었는지 대조하지 않는다.
   아직 Moderation에 도착하지 않은 활동을 포함한 완결성을 보장하지 않는다. 원본 snapshot·revision·
   gRPC 조회가 필요한 정책을 먼저 정한다. 이는 현재 단방향 종료 연결의 선행 작업이 아니다.
4. **성공/거부 피드백**: PostExpired는 발행하지만 별도 결정 적용/거부 이벤트 및 Moderation 재평가는 없다.
5. **콘텐츠 제재**: AI flagged는 검토 대기, 확정 제재만 적용하는 정책을 따른다. 검토 Case·승인 경로·
   콘텐츠 버전 검증·결정 이벤트가 아직 없으므로 기존 댓글 검사만으로 자동 삭제하지 않는다.
6. **운영 영속성**: 결정 감사 보존, Redis 유실/trim 이후 복구와 저장소 문서 정합성은 별도 설계한다.
   이번 작업에서 Moderation 저장소를 PostgreSQL로 이전하거나 gRPC를 추가하지 않는다.

Post에는 처리 이력·상태 변경·Outbox를 같은 MongoDB 트랜잭션에 저장하는 중복 방어를 구현했다.
`BOARD_REACTIVATED`로 이미 EXPIRED/DELETED인 게시물을 다시 열지 않는다. WS 종료 알림·Room 정리는
WGO-ARCH-06이며 이번 lifecycle Consumer 구현의 완료 범위에 포함하지 않는다.

## 2026-10-27 completion 상태

댓글 검사 결과 producer와 동일 ID 복구/재발행은 구현했다.
[콘텐츠 이벤트 계약](content-moderation-events.md)을 따른다. 결과 소비자의 검토/제재
정책과 Post 본문 인가, contentVersion, 결정 적용/거부 피드백은 여전히 미완료다.
Lifecycle v1의 필수 shape는 유지하며 version/작성자/실제 예정 시각만 선택 필드로 추가했다. 사유와 ENDED 근거는 내부 projection/로그에서 확인한다.
예정 ID의 bounded lease 스케줄, CLOSED 압축, 실제 XADD 실패 복구와 migration CLI는
[운영 문서](operations.md)를 따른다. 활성 단일 JSON 성장과 운영 영속성은 남은 과제다.
Notification의 최신 통합 결과와 실제 GCP 미검증 범위는 [완료 보고서](../../notification-service/COMPLETION_REPORT.md)를 따른다.
