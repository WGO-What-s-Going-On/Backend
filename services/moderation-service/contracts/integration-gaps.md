# 외부 연동 조사와 계약 요청

최초 조사 2026-10-15, lifecycle v1 수신 연결 상태 갱신 2026-10-24. 기존 구현과 사용자가 확정한 ENDED 스냅샷 정책을 반영합니다. 아래 신규 계약 제안은 구현된 외부 이벤트가 아닙니다. 기존 lifecycle v1의 Post 수신 연결은 별도로 구현 상태를 명시합니다.

## 확인한 기준

- dev `07769a20c3f95f547c83f73025f4ffd9fc43974f`: [Post 이벤트](../../post-service/contracts/post-events.md), [댓글 공감](../../post-service/contracts/comment-vote.md), `post/infrastructure/post-event-envelope.ts`, `post/application/commands.ts`, `lifecycle.ts`, `post.controller.ts`, `presentation/service-auth.ts`, `infrastructure/operations.cli.ts`.
- [내부 서비스 인증 권한표](../../../docs/contracts/service-authentication.md).
- Notification 별도 작업 브랜치 `feat/notification-service-구현` `e159626`: README, `src/event-consumer/post-event.ts`, `post-event.handler.ts`, persistence 처리. 현재 Moderation 브랜치의 Notification을 새 구현으로 간주하지 않는다.
- Map `src/post-consumer.ts`, `post-index.ts`; WS Gateway `src/realtime/post-events.ts`, `post-client.ts`.
- [Notion Lifecycle 설계](https://app.notion.com/p/3ec33f226af781c2a7d0d792c55f4da1), [Post 연동 현황](https://app.notion.com/p/3fa33f226af780b4b3b2f31afc8b47e2). 유예는 최신 확정 10분을 사용하며 window 재평가는 사용자 선택에 따라 고정 snapshot으로 보완했다.

## 게시글 본문 검사

PostCreated에는 content가 없다. title은 WGO 게시글 계약이 아니며 요청하지 않는다. `GET /internal/v1/posts/{postId}`는 상세 본문을 제공할 수 있지만 현재 서비스 JWT의 subject/issuer는 ws-gateway만 허용한다. meta/status는 본문 검사 계약이 아니며 meta는 목표 권한표에도 허용 호출자가 없다. 운영 비활성 batch-get이나 로컬 무인증 호환 경로로 이를 우회하지 않는다. 따라서 게시글 AI 검사는 미구현이다.

Post가 다음 중 하나를 확정해야 한다.

| 대안 | 필요한 합의 |
| --- | --- |
| PostCreated additive 확장 | content와 검사 대상 contentVersion 또는 hash, 보존/민감정보 범위, 과거 v1 누락 처리, 수정 시 재검사 이벤트 |
| 인가된 내부 상세 조회 | moderation-service 호출 권한·공개키 등록, ES256 대상/경로, postId → content/contentVersion/status 응답, 삭제/만료와 404/403/재시도 오류 정책, timeout |
| 전용 검사 요청 이벤트 | 대상 타입·ID, content 또는 인가된 content reference, contentVersion/hash, source eventId, correlationId와 재생 규칙 |

본문 조회 중 수정/삭제될 수 있으므로 검사 결과를 Post에 적용할 때 동일 contentVersion 검사가 필요하다. WS의 HS256 secret/신원을 Moderation에 복제하지 않는다.

## 콘텐츠 제재 결정

현재 댓글 결과는 Moderation 내부 Redis 저장이다. `CONTENT_MODERATION_DECIDED`의 합의된 wire/수신 consumer와 자동 조치 API가 없다. Post의 운영 CLI에서 검토된 moderationDecisionId를 사용해 삭제하는 기능이 있다는 사실은 네트워크 결정 소비 계약이 있다는 뜻이 아니다. flagged만으로 자동 삭제하지 않는다.

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

기존 output v1에는 decision version/ENDED 근거가 없다. 외부 합의 없이 필수 payload를 바꾸지 않고 내부 projection에만 저장했다. 신규 소비자가 역순 결정을 처리하려면 이 확장 합의가 선행되어야 한다.

## ENDED 집계의 완결성 경계

관계별 activityVersion은 종류 간 최신성을 결정하지 못한다. 현재 구현은 종류별 상태를 보존하고 다중 활성 사용자가 있으면 조기 종료를 보류한다. 수신한 이벤트의 중복·역순 및 동시 CAS 결과는 보호하지만, 아직 도착하지 않은 취소/활동을 알아낼 수는 없다. 모든 event-time 활동이 반영된 뒤 CLOSED를 확정하려면 다음 중 하나가 필요하다.

- `(postId,userId)` 전체 공감 전이 버전과 기존/새 종류를 함께 제공하는 변경 이벤트 및 재생 기준.
- 인가된 현재 활성 공감 snapshot API: snapshotVersion/기준 시각, 활성 관계와 관계 버전, pagination 중 일관성 보장.
- 원본 outbox의 게시물별 순서/완료 watermark 또는 명시적 지연 한도. snapshot 이후의 event cursor와 증분 적용 규칙.

이 계약 전에는 무한 지연 이벤트까지 포함하는 전역 완결성이나 CLOSED 이후 재개방을 보장하지 않는다. 이력 누락을 감지한 기존 projection에는 새 10분 window가 확보될 때까지 조기 종료를 보류한다.

## Notification

별도 Notification 브랜치도 post:events 9종을 소비하고 작성자 댓글/공감 알림을 처리한다. BOARD_STALE/BOARD_CLOSED 소비자는 없다. ParticipantJoined는 알림 수신 동의가 아니다.

종료 예정/종료 알림에는 Post가 실제 상태를 적용한 뒤 발행한 확정 이벤트와 상태 버전, 예정/확정 시각, 중복 키·취소/복귀 정책이 필요하다. 작성자와 알림에 동의한 참여자 목록을 조회하거나 재구성하는 인가된 계약도 필요하다. Moderation의 판단만으로 Push를 직접 보내거나 수신자를 추측하지 않는다.

## Map / Realtime

Map은 실제 PostDeleted/PostExpired를 소비해 index에서 제외한다. Moderation BOARD_CLOSED를 소비하지 않으므로 Post 원본 상태 적용이 선행되어야 한다.

WS Gateway는 참가 시 Post status가 ACTIVE인지 확인한다. 현재 PostEvents switch는 생성·댓글·공감·참여 생성 4종만 전달하고 삭제/만료 이벤트는 ACK한다. 따라서 상태 적용 뒤 신규 참가 차단과 별개로 기존 socket의 퇴장/쓰기 차단·종료 통지를 위한 확정 Post 이벤트 소비 계약과 구현이 필요하다. Moderation에서 Gateway socket을 직접 제어하지 않는다.

## Issue #31 범위

이 서비스 내부의 9종 소비, 활동/ENDED 판단, 삭제·만료, Redis 정합성 및 검증은 구현했다. 게시글 검사와 콘텐츠 제재/종료 알림의 종단 간 연동은 미완료다. 기존 lifecycle v1의 Post 종료 적용은 별도 opt-in Consumer로 연결했으며 버전·사유 등 확장 계약은 후속이다. Issue 전체를 완료로 닫지 않으며 사용자 확인 없이 PR을 생성하지 않는다.


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
