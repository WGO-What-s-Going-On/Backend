# Moderation Service 구현 및 검증 보고

검증일: 2026-10-15. 변경 범위는 `services/moderation-service`이다. 세부 정책은 [README](README.md), 외부 미구현 범위와 제안은 [integration-gaps](contracts/integration-gaps.md)에 정리했다.

## 1. Git 및 dev 반영

`feat/moderation-service-구현`에서 작업했다. 시작 HEAD와 원격 Moderation은 `b1e96d1`로 같았고 working tree는 clean이었다. fetch한 dev `07769a20c3f95f547c83f73025f4ffd9fc43974f`가 이미 포함되어 불필요한 merge/rebase를 만들지 않았다. `backup/moderation-before-extension`은 시작 HEAD를 보존한다. 기존 이력, 다른 서비스와 `.env`는 수정하지 않았다. 신규 커밋은 로컬에만 생성했다.

## 2. 변경 파일

- `src/event-consumer/post-event.ts`, `moderation-post-event.processor.ts`, `post-event.consumer.ts`: 9종 계약, 처리 분기, 소유권·종료 보완.
- `src/lifecycle/lifecycle.ts`, `lifecycle.service.ts`, `lifecycle.module.ts`, `redis-lifecycle.repository.ts`: 스냅샷/활동/버전/종료 및 원자 저장.
- 기존 unit/integration fixtures와 회귀 테스트를 갱신했다. `cas-atomicity`, `consumer-safety`, `lifecycle-activity`, `redis-restart` 통합 파일을 추가했다.
- README, 이 보고서, `contracts/integration-gaps.md`를 갱신/추가했다.

## 3. Post 9종 실제 처리

| 입력 | 결과 |
| --- | --- |
| PostCreated | 멱등 초기화, 기존 tombstone 유지 |
| PostCommentCreated | 유효한 새 댓글만 AI 결과 저장 후 활동 CAS |
| PostReactionCreated | 긍정 3종 활동, ENDED 집계, legacy LIKE ACK |
| PostParticipantJoined | 인식·ACK, 활동 아님 |
| PostReactionRemoved | 관계 최신 버전/비활성 반영, 종료 재확인 |
| PostCommentDeleted | 댓글 버전별 삭제 기록, 늦은 생성/활동 차단 |
| PostDeleted | 원본 삭제 tombstone, scan 제외·상태 정리 |
| PostParticipantLeft | 인식·ACK, 활동 아님 |
| PostExpired | 원본 만료 tombstone, scan 제외·부활 차단 |

Stream field와 envelope 식별자, producer/schema, UTC 시각, 사용 필드와 도메인 ID, 버전을 검증한다. 새 삭제 입력의 actor/reason도 검증한다. 최상위 도메인 객체를 사용하고 과거 생성 v1 추가 필드 누락을 허용한다.

## 4. Meaningful activity

댓글과 CURIOUS/STILL_HAPPENING/HELPFUL 생성은 실제 occurredAt으로 갱신한다. 저장된 활동 시각을 뒤로 움직이지 않는다. STALE 진입 이후 발생한 새 활동은 ACTIVE 복귀 + BOARD_REACTIVATED를 같은 CAS로 반영한다. ENDED·공감 취소·참여는 새 활동이 아니다.

## 5. ENDED 정책

5명 이상 AND 최근 고유 공감 사용자의 70% 이상이면 1시간 이전에도 ENDED STALE이 된다. 최초 집계/사용자별 관계 버전과 근거를 endedSnapshot에 고정한다. 유예 중 취소·변경·신규 ENDED를 적용하되 시간 경과로 기존 표를 제외하거나 staleAt을 연장하지 않는다. 조건 무효화 또는 새 의미 있는 활동은 ACTIVE, 조건 유지 10분은 CLOSED이다. 마지막 종료 근거는 endedAssessment에 보존한다.

## 6. 고유 사용자와 window

활성 공감 createdAt의 `(판단 시각-10분, 판단 시각]`을 사용한다. 취소·LIKE·미래 표는 제외한다. 한 사용자 한 활성 종류가 확실한 경우만 집계하고 분모 0은 불충족이다. 70%는 정수 교차 곱으로 판정한다. 유예에서는 최초 windowStart를 고정하고 관계의 최신 상태로 재평가한다.

## 7. 취소·버전·중복 정합성

관계 `(postId,userId,type)`별 최신 activityVersion을 사용한다. v1→v2 취소, v2→늦은 v1, v1→v2→v3 재등록 및 eventId 재전달을 검증했다. 종류 간 버전을 비교하지 않고 다중 활성은 조기 종료를 보류한다. JSON projection CAS로 관계 갱신과 스냅샷/전이를 함께 저장한다. 수신하지 않은 이벤트까지 포함하는 전역 event-time 완결성은 원본 snapshot/watermark 계약이 없으므로 보장 범위 밖이다.

## 8. 삭제·만료

원본 postVersion과 terminal 상태를 보존하고 CLOSED를 scan index에서 제거한다. 삭제/만료가 생성보다 먼저 도착해도 늦은 생성으로 부활하지 않는다. 반응/댓글 상세 상태는 정리하되 post tombstone은 유지한다. 이미 확정된 원본 종료를 BOARD_CLOSED로 재발행하지 않는다. 댓글 삭제도 별도 버전으로 보존하며 과거에 반영된 활동 시각을 소급 취소하지 않는다.

## 9. 일반 Lifecycle

생성 1시간 + 무활동 30분, 일반 STALE 유예 10분, CLOSED terminal을 유지한다. ENDED만 첫 1시간의 예외다. reason 없는 기존 STALE은 일반 정책으로 처리한다. 복귀 후 일반 비활성 조건은 독립적으로 적용된다. 과거의 공감 미추적 projection은 신규 이력 10분 확보 전 조기 종료를 보류한다.

## 10. OpenAI 댓글 재검증

safe/flagged 저장, categories/scores/model 매핑, timeout/429/500/400, 빈 결과, 잘못된 입력, 재전달, 삭제 중 API 완료를 검증했다. 실패를 정상 결과로 저장하지 않는다. 실제 smoke도 통과했다: 안전 문장 1회 + 위협 문장 1회 + Redis 댓글 경로 1회, 정상 요청 총 3회다. 이는 모델 정확도 평가가 아니다. 사용자 지정 `user-service/.env`의 OPENAI_API_KEY만 출력/파일 복사 없이 메모리에 주입하고 실행 후 복원했다.

## 11. 게시글 검사

미구현이다. PostCreated에 본문이 없다. 내부 상세 HTTP는 있지만 ws-gateway 전용 인증이며 Moderation 호출 권한이 없다. 이벤트 본문 확장 또는 인가된 contentVersion 포함 조회/검사 요청 계약이 필요하다.

## 12. 콘텐츠 제재 이벤트

미구현이다. 합의된 CONTENT_MODERATION_DECIDED wire/consumer/적용 API가 없다. 내부 결과 저장을 유지하고 flagged만으로 자동 삭제하지 않는다. 결정 ID·대상/본문 버전·정책 근거·멱등 적용/확정 응답 계약을 요청 문서에 적었다.

## 13. Post Lifecycle 실제 적용

미구현이다. Post에는 BOARD_* consumer/상태 적용 API가 없고 원본 상태 ACTIVE/EXPIRED/DELETED와 Moderation 상태가 다르다. 기존 output v1을 유지하며 Post의 결정 버전 CAS·원본 상태 매핑·적용 확정 이벤트 합의가 필요하다.

## 14. Redis 결과

실제 Redis 8 컨테이너에서 **38개 통합 테스트가 모두 통과**했다. 전용 DB 15만 사용했고 다른 DB가 빈 상태에서 해당 Compose Redis를 SAVE 후 실제 재시작해 snapshot/dedup/PEL 복구와 CLOSED 단일 발행을 검증했다. 평소 통합 명령은 재시작 1개를 skip하며 이번에는 명시적으로 활성화했다. 테스트 소유 key만 삭제했고 FLUSHDB/FLUSHALL을 사용하지 않았다. 전용 Redis는 원래 실행 중이던 컨테이너라 유지했다. checkpoint 정상 재시작 검증이며 crash/AOF/컨테이너 재생성 내구성 검증은 아니다.

## 15. 단위 결과

**42개 / 7개 파일 통과**. 시작 시 31개에서 11개 증가했다. OpenAI 실제 smoke는 별도 1개 파일/1개 테스트 통과다.

## 16. 정적 검사·빌드

Node.js 24.21.0 / pnpm 10.33.0에서 `pnpm typecheck`, `pnpm build`가 통과했다. root `npm run format`을 실행하고 무관한 포맷 변경은 복원했다. 변경한 TypeScript 전부의 Prettier check와 git diff whitespace check가 통과했다. 서비스 전체 Prettier 조회에는 수정하지 않은 기존 파일 16개의 형식/줄바꿈 경고가 있어 무관한 변경으로 커밋하지 않았다. 별도 ESLint 명령/설정은 없다.

## 17. 추가 테스트 수와 범위

시작 unit 31 + Redis 10에서 최종 unit 42 + Redis 38로 **39개 증가**했다. 4/5명·70% 경계, 고유 사용자 중복, 최초 1시간, 고정 window와 정확한 10분, 취소/재등록/변경/역순/동시성, 댓글/공감 복귀, 삭제 경합, terminal, Lua 부분 저장, 소유권 상실, DLQ 실패, graceful shutdown, 재시작을 포함한다. 실제 시각 대기 대신 Clock과 PEL IDLE을 사용한다.

## 18. 발견·수정 버그

1. 출력 Stream WRONGTYPE에서 Lua가 projection SET 후 실패해 이벤트 없는 상태 전이가 남았다. 실패 재현 후 preflight TYPE 검사로 수정했다. scan index에도 같은 방어와 회귀를 추가했다.
2. lease 만료 후 이전 worker가 새 소유자의 lease를 지우거나 done으로 덮어썼다. 성공/실패 두 경우를 실제 Redis로 재현 후 owner 비교와 heartbeat로 수정했다.
3. shutdown이 진행 중 API 결과/ACK 전에 연결을 닫았다. 실제 실패 재현 후 처리 완료를 기다리고 미시작 batch는 다음 worker에 남기도록 수정했다.
4. 기존 활동 함수가 staleAt 이전의 지연 활동도 복귀시킬 수 있었다. 발생 시각 경계에 따라 복귀하도록 보완하고 회귀로 검증했다.

## 19. 기능별 커밋

| SHA | 변경 |
| --- | --- |
| 6535ab1 | Lua 부분 저장 방지와 실패 재현 테스트 |
| 01d33f9 | Consumer 소유권 경합·graceful shutdown 보완 |
| b19fd31 | 9종 소비, 활동/ENDED 스냅샷, 삭제·만료 및 Redis 검증 |
| 7d0af93 | Redis 재시작·scan index·OpenAI 실패 회귀 추가 |

문서 커밋은 이 보고서와 README/계약 요청을 포함하며 최종 Git log에서 확인할 수 있다.

## 20. 외부 blocker

게시글 content 접근, 콘텐츠 제재 적용, Post 실제 상태 적용/확정 이벤트, 종료 알림 수신자 동의·Notification 소비 계약이 없다. Map은 PostDeleted/Expired를 반영하지만 Moderation 판단만으로는 바뀌지 않는다. WS는 신규 참가 때 Post ACTIVE를 확인하나 기존 socket 종료 처리는 추가 구현이 필요하다. 이 서비스에서 권한이나 상태 변경을 우회하지 않았다. Redis 내구성/원본 재생 및 전역 watermark도 운영 연동 요구사항이다.

## 21. Issue / PR

현재 계약으로 가능한 서비스 내부 구현과 검증은 완료했다. 위 외부 항목이 남아 Issue #31 전체는 미완료다. 검토 가능한 로컬 커밋과 문서를 준비했으며 사용자 확인 전 PR 생성/Issue 종료는 수행하지 않았다.

## 22. 최종 작업 상태

모든 변경은 Moderation 디렉터리 안에만 있다. 커밋 후 `git status --porcelain`의 빈 결과와 dev 포함 여부를 최종 확인한다. 원격 push는 수행하지 않았다. credential과 다른 서비스 데이터/설정은 변경하지 않았다.
