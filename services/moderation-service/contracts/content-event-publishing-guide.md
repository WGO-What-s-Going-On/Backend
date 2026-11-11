# 게시글·댓글 모더레이션 이벤트 발행 안내

기준: 2026-11-11, `fix/moderation-content-enforcement`의 현재 구현.

이 문서는 콘텐츠 검사 입력부터 검사 결과·숨김 결정 발행과 Post 소비까지 한곳에 정리한다.
Moderation은 **검사 결과와 숨김 결정을 발행**한다. 실제 콘텐츠 숨김·삭제·DB 상태 변경은 수행하지 않는다.
자동 숨김 결정 기능은 **기본 OFF**이며, 아래 설정은 코드 기본값이다. 운영 활성화 상태를 뜻하지 않는다.

## 1. 전체 흐름

```text
Post Service
  └─ post:events
       ├─ PostCreated / PostUpdated             → 게시글 제목 + 본문 검사
       └─ PostCommentCreated / PostCommentUpdated → 댓글 본문 검사
            ↓ Moderation Consumer Group: post-moderation
            ↓ 원본 콘텐츠 버전 관측 (결정 기능 ON일 때)
            ↓ OpenAI 검사 → 최초 저장된 불변 결과(canonical) 확정
            ├─ moderation:content-events
            │    └─ CONTENT_MODERATION_EVALUATED (정상·유해 모두)
            └─ 결정 기능 ON + flagged=true + 버전/삭제 상태 검증 통과
                 └─ moderation:content-decisions
                      └─ CONTENT_MODERATION_DECIDED (decision: HIDE)
                           ↓ Post Consumer 구현 필요
                           ↓ 현재 버전·중복·삭제 경합 검증
                           └─ 실제 숨김 및 조회/실시간 가시성 반영
```

두 출력은 **별도 Stream**이다. 발행 순서는 검사 결과 → 숨김 결정이지만,
소비자 실행 시점까지 같은 순서로 관측된다고 보장하지 않는다.
Post는 숨김 결정 자체의 필드로 검증할 수 있어야 한다.

## 2. 어떤 입력을 검사하는가

| Post 입력 이벤트     | 검사 대상               | 보존하는 버전     | 동작                               |
| -------------------- | ----------------------- | ----------------- | ---------------------------------- |
| `PostCreated`        | 게시글의 전체 제목·본문 | `postVersion`     | 완전한 콘텐츠 스냅샷이 있으면 검사 |
| `PostUpdated`        | 수정 후 전체 제목·본문  | `postVersion`     | 콘텐츠 스냅샷이 있는 수정만 검사   |
| `PostCommentCreated` | 댓글 본문               | `activityVersion` | 기존 댓글 중복·삭제 검증 후 검사   |
| `PostCommentUpdated` | 수정 후 댓글 본문       | `activityVersion` | 원본 수정 버전으로 검사            |

게시글은 `제목 + 줄바꿈 2개 + 본문`, 댓글은 댓글 본문을 OpenAI에 전달한다.
검사 결과 이벤트에는 그 원문을 넣지 않는다.

- 제목·본문이 없는 과거 게시글 이벤트와 종료·재개 등 상태만 변경된 `PostUpdated`는 검사하지 않는다.
- 부분 콘텐츠 스냅샷이나 잘못된 필수 필드는 정상 결과를 만들지 않고 입력 오류로 처리한다.
- 과거 댓글 생성 계약의 버전 누락은 기존 규칙대로 1로 해석한다. 댓글 수정에는 원본 버전이 필요하다.
- 이미 처리했거나 삭제된 댓글 입력은 새 API 검사를 생략할 수 있다. 기존 저장 결과가 있으면 미완료 발행을 복구한다.
- `PostCommentDeleted`, `PostDeleted`, `PostExpired`는 새 콘텐츠 검사를 요청하지 않는다.
  결정 기능 ON일 때 삭제/만료 상태를 기록해 뒤늦은 숨김 결정을 막는다.
- 상태만 바뀐 게시글도 원본 버전이 있으면 최신 버전으로 관측한다. 오래된 검사 결과의 결정 발행을 막기 위해서다.

## 3. 두 출력 이벤트의 차이와 발행 조건

| 구분                      | 검사 결과                                  | 숨김 결정                                          |
| ------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `eventType`               | `CONTENT_MODERATION_EVALUATED`             | `CONTENT_MODERATION_DECIDED`                       |
| 기본 Stream               | `moderation:content-events`                | `moderation:content-decisions`                     |
| 의미                      | 이 버전의 콘텐츠를 검사한 사실과 모델 결과 | 정책에 따라 이 버전을 숨기라는 결정                |
| 대상                      | `POST`, `COMMENT`                          | `POST`, `COMMENT`                                  |
| 정상 결과 `flagged=false` | 발행                                       | 미발행                                             |
| 유해 결과 `flagged=true`  | 발행                                       | 기능 ON이며 버전·삭제 상태 검증을 통과할 때만 발행 |
| 자동 숨김 설정 OFF        | 영향 없음                                  | 발행하지 않음                                      |
| 실제 숨김 완료 의미       | 없음                                       | 없음. Post가 별도 적용해야 함                      |

| 처리 상황                                            | EVALUATED                    | DECIDED                        |
| ---------------------------------------------------- | ---------------------------- | ------------------------------ |
| 검사 성공, `flagged=false`                           | 발행                         | 미발행                         |
| 검사 성공, `flagged=true`, 결정 기능 OFF             | 발행                         | 미발행                         |
| 검사 성공, `flagged=true`, 기능 ON, 최신 버전·미삭제 | 발행                         | `HIDE` 발행                    |
| 검사 중 새 버전 또는 삭제/만료를 관측                | 완료된 검사 사실은 발행 가능 | 이전 버전의 새 결정 발행 차단  |
| OpenAI 장애·timeout·잘못된 응답                      | 정상 결과 미발행             | 미발행. 입력 재시도 대상       |
| Redis 저장/XADD 장애                                 | 실패 단계부터 복구 필요      | 입력 성공 처리하지 않고 재시도 |

`flagged=true`는 원래 모델 신호다. 현재 구현은 명시적으로 활성화한 정책에서만 이를
`HIDE`로 변환하며, 별도 카테고리 목록이나 점수 임계값은 사용하지 않는다.
`flagged=false`의 `NO_ACTION`, 복원, 숨김 해제 이벤트는 발행하지 않는다.
결정 이벤트가 없다는 사실만으로 정상 콘텐츠라고 판단해서는 안 된다.

## 4. Redis 전송 형식과 이벤트 필드

입출력 모두 Redis Stream의 `eventId`, `eventType`, `data` 필드를 사용한다.
`data`는 JSON 문자열이며 이벤트의 전체 flat 객체다. 중첩 `payload`로 감싸지 않는다.

```text
XADD <stream> * eventId <eventId> eventType <eventType> data <JSON 문자열>
```

Redis가 부여하는 Stream ID는 읽기·ACK용 커서다. 중복 판정은 아래 도메인 이벤트 ID로 한다.

### 공통 필드

| 필드                           | 내용                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `eventId`                      | 검사 결과 또는 결정 이벤트의 고유 ID. 재시도에도 동일            |
| `eventType`                    | `CONTENT_MODERATION_EVALUATED` 또는 `CONTENT_MODERATION_DECIDED` |
| `schemaVersion`                | `1`                                                              |
| `producer`                     | `moderation-service`                                             |
| `targetType`                   | `POST` 또는 `COMMENT`                                            |
| `postId`                       | 대상 게시글 ID. 댓글도 소속 게시글 ID 포함                       |
| `sourceEventId`                | 검사를 유발한 원본 Post 이벤트 ID                                |
| `postVersion`                  | POST 전용. 검사한 원본 게시글 버전                               |
| `commentId`, `activityVersion` | COMMENT 전용. 대상 댓글과 검사한 원본 댓글 버전                  |
| `occurredAt`                   | 저장된 검사 완료 시각. Post의 숨김 적용 시각이 아님              |
| `correlationId`                | 원본 추적 ID. 과거 저장 결과에 없으면 `sourceEventId` 사용       |

POST는 `commentId`/`activityVersion`을 포함하지 않고 COMMENT는 `postVersion`을 포함하지 않는다.
신규 댓글 검사는 원본 버전을 보존한다. 과거 저장된 EVALUATED에는 `activityVersion`이 없을 수 있으나,
DECIDED는 대상의 양의 safe integer 버전이 필수이며 누락된 버전을 추측하지 않는다.

### 검사 결과 전용 필드

| 필드             | 내용                                                       |
| ---------------- | ---------------------------------------------------------- |
| `flagged`        | OpenAI 결과의 boolean                                      |
| `categories`     | 모델이 반환한 카테고리별 boolean                           |
| `categoryScores` | 카테고리별 0~1 점수. 제재 확률이나 자체 차단 임계값이 아님 |
| `model`          | 응답 모델 이름                                             |
| `evaluatedAt`    | `occurredAt`과 같은 검사 완료 시각                         |
| `authorId`       | 원본 작성자 ID. 과거 결과에서는 생략 가능                  |

### 숨김 결정 전용 필드

| 필드                   | 내용                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `moderationDecisionId` | Post가 적용·중복·거부 결과를 기록할 결정 ID                                       |
| `evaluationEventId`    | 근거가 된 EVALUATED의 `eventId`                                                   |
| `decision`             | `HIDE`                                                                            |
| `reason`               | `OPENAI_MODERATION_FLAGGED`                                                       |
| `policyVersion`        | 기본 `openai-flagged-hide-v1`                                                     |
| `policyFingerprint`    | 정책 버전과 고정 규칙의 SHA-256. 같은 버전을 다른 규칙으로 재사용하지 않도록 검증 |

두 출력 모두 제목·본문·API Key·위치·내부 `sourceHash`·SDK 오류 상세를 포함하지 않는다.

## 5. 이벤트 예시

아래 ID와 카테고리는 형식 설명용이다. `<sha256>`은 실제로 64자리 소문자 해시이고,
카테고리는 모델 응답에 따라 달라지며 예시는 전체 카테고리 목록이 아니다.

### 게시글 검사 결과 — `moderation:content-events`

```json
{
  "eventId": "evt_content_<sourceEventId의-sha256>",
  "eventType": "CONTENT_MODERATION_EVALUATED",
  "schemaVersion": 1,
  "producer": "moderation-service",
  "targetType": "POST",
  "postId": "post_<uuid>",
  "postVersion": 3,
  "sourceEventId": "evt_<original-uuid>",
  "flagged": true,
  "categories": { "violence": true },
  "categoryScores": { "violence": 0.95 },
  "model": "omni-moderation-latest",
  "authorId": 42,
  "evaluatedAt": "2026-11-11T00:00:00.000Z",
  "occurredAt": "2026-11-11T00:00:00.000Z",
  "correlationId": "request-42"
}
```

댓글 검사 결과는 같은 구조에서 `targetType`을 `COMMENT`로 바꾸고,
`postVersion` 대신 `commentId`와 `activityVersion`을 넣는다.
정상 결과도 같은 구조로 `flagged=false`와 실제 카테고리·점수를 발행한다.

### 댓글 숨김 결정 — `moderation:content-decisions`

```json
{
  "eventId": "evt_decision_<decision-sha256>",
  "eventType": "CONTENT_MODERATION_DECIDED",
  "schemaVersion": 1,
  "producer": "moderation-service",
  "moderationDecisionId": "decision_<decision-sha256>",
  "targetType": "COMMENT",
  "postId": "post_<uuid>",
  "commentId": "comment_<uuid>",
  "activityVersion": 2,
  "sourceEventId": "evt_<original-comment-uuid>",
  "evaluationEventId": "evt_content_<comment-sourceEventId의-sha256>",
  "decision": "HIDE",
  "reason": "OPENAI_MODERATION_FLAGGED",
  "policyVersion": "openai-flagged-hide-v1",
  "policyFingerprint": "<policy-sha256>",
  "occurredAt": "2026-11-11T00:00:00.000Z",
  "correlationId": "request-43"
}
```

게시글 숨김 결정은 같은 구조에서 `targetType`을 `POST`로 바꾸고,
`commentId`/`activityVersion` 대신 `postVersion`을 넣는다.

## 6. 중복·역순·장애 시 동작

1. EVALUATED ID는 `evt_content_` + `SHA256(sourceEventId)`다.
   DECIDED ID는 `evt_decision_` + `SHA256(JSON.stringify([evaluationEventId, policyVersion]))`다.
   `moderationDecisionId`는 같은 결정 해시에 `decision_` 접두사를 붙인다.
2. 동일 원본의 최초 저장 결과를 사용한다. 경쟁 worker가 다른 모델 답을 받아도 저장된 결과만 결정 근거로 삼는다.
   재시도에서 시각·버전·ID·payload를 새로 만들지 않는다.
3. 결정 기능 ON일 때 API 호출 전 최신 대상 버전을 관측하고, 발행 시 Redis Lua로 버전·삭제 상태를 확인한다.
   예를 들어 댓글 v2를 관측한 뒤 v1의 유해 응답이 도착하면 v1의 새 HIDE는 발행하지 않는다.
4. 검사 결과 저장·발행 뒤 결정 발행이 실패하면 입력을 성공 처리하지 않는다.
   저장된 준비 데이터로 재시도하므로 앞 단계에서 저장한 검사를 다시 API 호출할 필요가 없다.
   결과 저장 전 장애나 동시 최초 처리에서는 API 재호출이 가능하다.
5. Lua는 런타임 실패를 rollback하지 않는다. XADD 이후 응답·receipt 유실 시 같은 ID가 다시 전송될 수 있어
   전달 보장은 **at-least-once**다. 소비자 자체 멱등 처리가 필요하다.
6. 입력 group은 기존 `post-moderation`을 유지한다. pending 회수·재시도 후 5회 실패 입력은
   `moderation:post:dead`에 저장한 뒤 ACK한다. DLQ 저장도 실패하면 pending으로 남는다.
7. 이미 발행된 결정은 회수할 수 없고 아직 수신하지 못한 수정·삭제도 알 수 없다.
   따라서 Post는 실제 적용 트랜잭션에서 현재 버전을 반드시 다시 비교해야 한다.

기존 `content:republish` CLI는 검사 결과 재발행용이며 결정 Stream 복구 도구가 아니다.
결정 기능 ON 전환이나 정책 버전 변경만으로 이미 완료된 과거 입력을 자동 소급 처리하지 않는다.

## 7. 환경변수와 Stream 분리

| 환경변수                                        | 기본값                         | 용도                                                              |
| ----------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `POST_EVENT_STREAM`                             | `post:events`                  | 입력                                                              |
| `MODERATION_CONSUMER_GROUP`                     | `post-moderation`              | Moderation 입력 소비 group                                        |
| `MODERATION_CONTENT_EVENT_STREAM`               | `moderation:content-events`    | EVALUATED 출력                                                    |
| `MODERATION_CONTENT_DECISION_STREAM`            | `moderation:content-decisions` | DECIDED 출력                                                      |
| `MODERATION_CONTENT_ENFORCEMENT_ENABLED`        | `false`                        | `true`일 때만 결정 발행·대상 버전 관측                            |
| `MODERATION_CONTENT_ENFORCEMENT_POLICY_VERSION` | `openai-flagged-hide-v1`       | Post와 합의할 정책 식별자                                         |
| `REDIS_URL`                                     | 미설정                         | 관련 상태와 Stream이 같은 단일 Redis primary/DB를 사용하도록 설정 |
| `OPENAI_API_KEY`                                | 미설정                         | 외부 검사 credential. 이벤트나 로그로 전달하지 않음               |

Lifecycle 출력 `moderation:events`와 신고 출력 `moderation:report-events`도 별도로 유지한다.
콘텐츠 결정을 Lifecycle Stream으로 보내면 기존 소비자가 모르는 이벤트를 ACK할 수 있으므로 혼용하지 않는다.
Post Consumer 연동과 정책 허용 목록 확인 전에는 결정 기능을 OFF로 유지한다.
현재 다중 키 Lua는 Redis Cluster에 호환되지 않는다. 내구성·보존·archive·용량·ACL/TLS 설정도 배포 전 필요하다.
검사 결과 보존은 30일이고, 결정 상태·receipt·최신 버전·tombstone에는 자동 TTL이 없다.

## 8. Post 팀이 구현해야 할 부분

1. `moderation:content-decisions`에 독립 Consumer Group(권장 `post-content-enforcement`)을 만든다.
   `schemaVersion`, 대상 ID·버전, `decision`, `reason`, 허용 `policyVersion`/fingerprint를 검증한다.
2. 현재 `postVersion` 또는 `activityVersion`과 결정의 버전이 같은지 **적용 트랜잭션 안에서** 확인한다.
3. 결정 receipt와 숨김 상태, 필요한 카운터 변경·결과 Outbox를 같은 트랜잭션에 저장한 후 ACK한다.
4. 중복·stale·이미 삭제·이미 숨김·미존재·적용 성공을 구분하고, 일시 장애는 재시도하며 poison은 DLQ에 보존한다.
5. HIDE의 목록·상세·답글·미디어·검색·실시간 비노출과 복구 정책을 확정한다.
   HIDE를 기존 영구 삭제 함수에 임의로 연결하지 않는다.
6. 적용·거부·실패 피드백 이벤트 계약을 합의한다. 결정 발행만으로 FE/Notification에 조치 완료를 표시하지 않는다.

현재 구현 범위는 Moderation 생산자까지다. **Post Consumer, 실제 숨김, FE 노출 제어,
Post 적용 결과 피드백과 서비스 간 숨김 E2E는 아직 연동되지 않았다.**

## 상세 계약과 구현 위치

- [EVALUATED 상세 계약](content-moderation-events.md)
- [DECIDED 상세 계약·Post 소비 요구](content-enforcement-events.md)
- [Post 팀 인계 요청](post-content-contract-request.md)
- [QA8 구현·검증 보고](../QA8_CONTENT_ENFORCEMENT_REPORT.md)
- [입력 처리](../src/event-consumer/moderation-post-event.processor.ts)
- [검사 및 canonical 결과 사용](../src/content-moderation/content-moderation.service.ts)
- [검사 결과 필드 생성](../src/content-moderation/content-event.ts)
- [결정 정책·필드·ID 생성](../src/content-moderation/enforcement-policy.ts)
- [결정 버전 검증·Redis 발행](../src/content-moderation/content-enforcement.service.ts)
