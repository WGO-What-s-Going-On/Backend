# QA 이슈 8 — 게시글·댓글 자동 숨김 결정 발행

2026-11-11. 이 보고서는 2026-11-09의 댓글·카테고리 정책 초안 보고를 대체한다.
작업 브랜치: fix/moderation-content-enforcement. 시작 시 미커밋 변경은 없었다.
origin/dev를 fetch하고 최신 **4f3cbb2**로 기존 작업을 rebase했다.
이전 브랜치는 backup/moderation-enforcement-before-rebase-20261111에 보존했다.
충돌은 Moderation 내부에서 최신 게시글·댓글 검사 구현을 보존해 해결했다.

## 1. 구현 내용과 변경 파일

최신 dev의 PostCreated/PostUpdated 제목·본문·postVersion 검사, 댓글 생성·수정 검사,
canonical Redis 검사 결과와 CONTENT_MODERATION_EVALUATED 발행을 그대로 재사용했다.
OpenAI adapter·모델·기존 검사 wire를 중복 구현하거나 변경하지 않았다.

**기능 ON + canonical flagged === true → HIDE 결정 발행**이라는 요청 정책을 구현했다.
flagged=false에서는 결정/NO_ACTION/복원 이벤트를 발행하지 않는다. 기본 설정은 OFF다.
이전 브랜치의 카테고리별 정책 JSON, HIDE_COMMENT/NO_ACTION 초안은 현재 정책으로 대체했다.

| 파일 | 핵심 변경 |
| --- | --- |
| src/content-moderation/enforcement-policy.ts | 고정 flagged-only 정책, POST/COMMENT별 버전·대상 구분, 결정 ID·reason·policyVersion |
| src/content-moderation/content-enforcement.service.ts | 별도 stream과 준비 데이터·발행 receipt, POST/COMMENT 버전 fencing, 재시도·readiness |
| src/content-moderation/content-moderation.service.ts | canonical 결과를 결정에 연결, 재처리 시 기존 검사 재사용, 버전 충돌 확인 |
| src/event-consumer/moderation-post-event.processor.ts | API 대기 전 게시글/댓글 버전 관측, 기존 삭제·만료 경계 연결 |
| src/content-moderation/content-moderation.module.ts / src/event-consumer/readiness.controller.ts | 결정 서비스 DI와 활성화 시 의존성 검사 |
| src/config/configuration.ts / .env.example | OFF 기본값, policyVersion, 결정 stream 설정 |
| test/enforcement-policy.test.ts | flagged 조건, 대상별 필드, 버전·민감정보 제외·기본 OFF 검증 |
| test/integration/content-enforcement.integration.ts / redis-harness.ts | 실제 Redis 기반 POST/COMMENT 결정·중복·역순·장애 복구 |
| README.md / contracts/content-moderation-events.md / integration-gaps.md | 검사 사실·결정·적용의 현재 경계 반영 |
| contracts/content-enforcement-events.md / post-content-contract-request.md | wire와 Post 소비자 인계 계약 |

모든 변경은 **services/moderation-service 내부**다. 다른 서비스, 루트 설정, 배포 설정은 수정하지 않는다.
포맷도 대상 서비스의 변경 파일로만 제한했다.

## 2. Redis Stream 이벤트 스키마

Stream: moderation:content-decisions. Redis fields: eventId, eventType, data.
eventType=CONTENT_MODERATION_DECIDED, schemaVersion=1, producer=moderation-service.

공통 필드: eventId, moderationDecisionId, targetType, postId, sourceEventId,
evaluationEventId, **decision=HIDE**, **reason=OPENAI_MODERATION_FLAGGED**,
policyVersion, policyFingerprint, occurredAt, correlationId.
POST는 postVersion을, COMMENT는 commentId와 activityVersion을 포함하며 반대쪽 버전 필드는 포함하지 않는다.
본문·제목·API Key·sourceHash·SDK 오류 상세는 포함하지 않는다.

ID는 evaluationEventId와 policyVersion의 SHA-256으로 결정하여 재시도에도 동일하다.
원래 검사 시각·correlation·대상 버전을 유지한다. 준비 payload/XADD/receipt는 Lua로 처리한다.
XADD 실패는 입력 성공이 아니며 pending/DLQ 재처리에서 같은 검사 결과와 결정을 재사용한다.
원자적 격리와 disk 내구성은 다르며, 응답/receipt 유실에는 동일 ID 재발행 가능성이 있어 at-least-once다.
Post의 영속 멱등 처리는 여전히 필요하다.

세부 스키마·복구·보존 제약: [결정 계약](contracts/content-enforcement-events.md).

## 3. 테스트 결과

Node 24.22.2, 격리된 로컬 Redis 7 / 6399 포트의 빈 테스트 DB 사용.
OpenAI는 이 실행에서 provider/SDK 대역을 사용했다. 모델 정확도나 실제 API 실수신 검증으로 보고하지 않는다.

| 검증 | 결과 |
| --- | --- |
| 전체 단위·HTTP·OpenAPI | 17파일, 108개 통과 |
| 전체 실제 Redis 통합 | 10파일 통과, 94개 통과 / opt-in 재시작 2개 skip |
| 결정 경로 통합 | 위 통합에 포함, POST/COMMENT·장애 복구 21개 통과 |
| typecheck / build | 통과 |
| 변경 TS 파일 포맷 / git diff --check | 통과 |

기본 OFF 상태의 기존 전체 회귀와 ON 상태의 결정 통합을 함께 확인했다.

검증 범위: 게시글·댓글 정상/유해 검사, flagged=true에만 HIDE, 기본 OFF,
민감정보 제외, 중복·동시 발행, 게시글 postVersion·댓글 activityVersion 보존,
새 정상 수정 뒤 과거 유해 응답, 댓글 삭제·게시물 삭제/만료 경합, Redis 연결 불가·잘못된 TYPE,
POST/COMMENT XADD 런타임 실패 후 복구, 결정 응답/입력 ACK 유실과 pending 재처리,
OpenAI 장애 후 복구, 정책 fingerprint 충돌, safe-integer 버전 보존.
전체 통합에는 기존 Lifecycle·신고·검사 결과 발행 회귀가 포함된다.

실제 Post 숨김·FE 비노출 E2E와 운영 persistence/failover·배포는 이번 범위 밖이므로 미실행이다.
서비스에 별도 lint script는 없다. 실제 API smoke는 이번에 재실행하지 않았다.

## 4. 운영 활성화 환경변수

| 환경변수 | 기본값 |
| --- | --- |
| MODERATION_CONTENT_ENFORCEMENT_ENABLED | false |
| MODERATION_CONTENT_ENFORCEMENT_POLICY_VERSION | openai-flagged-hide-v1 |
| MODERATION_CONTENT_DECISION_STREAM | moderation:content-decisions |
| REDIS_URL | 기존 검사·입력과 같은 Redis endpoint/DB |

Post 소비 계약을 먼저 확인하고 staging 검증 후에만 enabled=true로 전환한다.
이전 초안의 MODERATION_CONTENT_ENFORCEMENT_POLICY_JSON은 사용하지 않는다.
단일 Redis primary/DB, ACL/TLS, AOF/복제·백업/noeviction, receipt·tombstone 보존·용량·trim 정책이 필요하다.
이번에 운영 환경변수나 배포 설정은 활성화하지 않았다.

## 5. Post 팀 Consumer 요구사항

- 별도 group으로 소비하고 runtime wire·허용 정책·발행자 권한을 검증한다.
- **현재 원본 postVersion/activityVersion이 검사 버전과 같은지 적용 트랜잭션 안에서 확인한다.**
- decision receipt + 숨김 상태·필요한 카운터/투표 변경 + 적용 결과 Outbox를 원자적으로 저장 후 ACK한다.
- 중복·stale·이미 삭제/숨김·미존재·적용 성공을 구분한다. 일시 실패는 pending, poison은 DLQ 후 ACK한다.
- HIDE를 삭제 함수에 임의 매핑하지 않는다. 저장 상태와 목록/상세/답글/미디어/검색/실시간 가시성·복구를 정한다.
- decisionId/sourceEventId/대상 버전/상태·사유·처리 시각을 추적하는 적용 결과 피드백을 합의한다.

전체 인계 문서: [Post 팀 계약 요청](contracts/post-content-contract-request.md).

## 6. 아직 연동되지 않은 부분

Post Consumer, Post DB 상태 변경, 실제 숨김·조회 비노출, FE 표시 제어, 적용/거부 피드백은 미구현이다.
Moderation의 성공 로그·input ACK·결정 발행은 Post 적용 성공을 의미하지 않는다.
아직 도착하지 않은 수정·삭제를 알 수 없고 이미 발행한 과거 결정은 회수하지 못하므로 Post 버전 검증은 필수다.
정상 평가에는 복원 이벤트가 없고 정책 전환·과거 완료 입력의 자동 재검사/소급 결정도 수행하지 않는다.

push, PR 생성, merge, 운영 배포는 하지 않는다.
