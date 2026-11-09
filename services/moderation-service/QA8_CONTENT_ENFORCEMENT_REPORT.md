# QA 이슈 8: Moderation 독립 구현·검증 보고

작성일 2026-11-09. 기준 `origin/dev` = `bc2547a4d3a794c1da09df3afd076ae150d8605c`.
작업 브랜치 `fix/moderation-content-enforcement`. 작업 시작 시 dev의 미커밋 변경은 없었다.
최종 변경·커밋 범위는 **services/moderation-service 내부만**이다.

## 1. 기존 구현과 확인한 결함·연동 공백

- PostCommentCreated와 PostCommentUpdated 모두 기존 processor → OpenAI
  `omni-moderation-latest` → canonical Redis 결과 → CONTENT_MODERATION_EVALUATED
  → Lifecycle 활동 기록 → input ACK 흐름이 있었다. 수정은 activityVersion/updatedAt 검증이 있다.
- moderation:content-events는 검사 사실 stream이다. Notification은 검사 사실을
  조치 완료로 알리지 않으며 Post는 이 stream을 차단 명령으로 소비하지 않는다.
- 정책 기반 제재 결정 생산자와 Post 자동 적용 소비자가 없었다. 따라서 모델이
  유해성을 검출해도 실제 콘텐츠 비노출로 이어지지 않는 것은 이 연결 공백 때문이었다.
- Post의 운영자 moderateComment는 decisionId가 비어 있지 않은지와 길이를 확인하고,
  검토한 activityVersion을 삭제 트랜잭션에서 현재 버전과 대조한다. 이는 네트워크
  승인·숨김 명령 계약이 아니다. 기존 삭제 기능을 숨김에 임의 매핑하지 않았다.
- 기존 검사 계약의 "제재 결정 없음" 설명과 Post 문서의 "Moderation이 정책·조치를
  결정"한다는 책임 선언 사이에 구현 공백이 있었다. 새 생산자의 구현 상태와 기본 OFF,
  Post 미구현 경계를 각각 문서에 반영했다.
- PostCreated에는 검사할 게시글 본문이 없어 게시글 검열은 여전히 미구현이다.

## 2. 수정 파일과 핵심 변경

| 파일 | 변경 |
| --- | --- |
| src/content-moderation/enforcement-policy.ts | 승인 정책 검증, 카테고리 규칙과 결정 생성, 안정적인 결정 ID/fingerprint |
| src/content-moderation/content-enforcement.service.ts | 기본 OFF, 버전·삭제 fencing, 독립 Redis stream, 준비 데이터·발행 receipt, 장애 복구·readiness |
| src/content-moderation/comment-moderation.service.ts | 저장된 canonical 검사 결과로 결정, 발행 실패 시 실패 전파, 중복 원본 버전 충돌 검증 |
| src/content-moderation/content-moderation.module.ts | 결정 서비스 DI 등록·공개 |
| src/event-consumer/moderation-post-event.processor.ts | 모델 대기 전 수정 버전 관측, 삭제·만료 tombstone 연결 |
| src/event-consumer/readiness.controller.ts | 활성화된 결정 stream/정책 상태 확인 |
| src/config/configuration.ts / .env.example | 기본 false 설정, 승인 정책 JSON, 독립 결정 stream |
| test/enforcement-policy.test.ts | 정책/기본 OFF/stream 분리/flagged와 결정 분리 |
| test/integration/content-enforcement.integration.ts | 실제 Redis 결정 흐름과 중복·역순·수정·삭제·장애 경합 |
| test/integration/redis-harness.ts | 격리된 테스트 정책 주입, 기존 회귀는 비활성 경로 유지 |
| test/smoke/korean.smoke.ts | 한국어 합성 7유형의 실제 모델 관측, 본문·키 출력 금지 |
| contracts/content-enforcement-events.md | 결정 wire, 정책 설정, Post 소비·피드백 요구, 운영 제약 |
| contracts/post-content-contract-request.md | 게시글 본문·버전과 Post 숨김 소비에 대한 합의 요청 |
| contracts/content-moderation-events.md / contracts/integration-gaps.md / README.md | 현재 탐지·결정·적용 경계와 검증 방법 갱신 |

기존 Lifecycle 판단 규칙·출력 wire, 신고 API/worker, Notification 및 Post 코드는 변경하지 않았다.

## 3. 실제 한국어 탐지 결과

2026-11-09 14:30 KST, 기존 로컬 키를 프로세스에만 로드했다. 모델은
`omni-moderation-latest`, 합성 문장 유형당 1회 관측이다. 사용자 콘텐츠를 보내지 않았다.
키와 원문은 로그에 출력하지 않았고 fixture ID·모델 boolean/score만 기록했다.

| 합성 유형 / caseId | flagged | true 카테고리 | 주요 score |
| --- | --- | --- | --- |
| 정상 인사 / normal | false | 없음 | harassment 0.000021 |
| 대상 없는 감탄형 욕설 / profanity | false | 없음 | harassment 0.005760, violence 0.010106 |
| 상대방 대상 욕설 / directed-profanity | true | harassment | harassment 0.892232 |
| 상대방에 대한 협박 / threat | true | harassment, harassment/threatening, violence | threatening 0.458491, violence 0.952979 |
| 폭력 행위 묘사 / violence | true | violence | violence 0.935620 |
| 초성으로 바꾼 상대방 욕설 / obfuscated-profanity | true | harassment | harassment 0.464438 |
| 위협을 피하라는 안전 안내 / safety-context | true | violence | violence 0.200232 |

**탐지 범위 한계:** 단순 욕설은 모델 flagged만으로 모두 걸러지지 않았다.
반대로 안전 안내도 violence로 잡혔다. 7개 사례를 전체 한국어 정확도나 모든 우회 표현의
검출 보장으로 해석하지 않는다. 금칙어 사전·추가 분류 정책은 이번에 임의로 도입하지 않았다.
Score를 확률·운영 임계값으로 사용하지 않았다.
[OpenAI 공식 문서](https://developers.openai.com/api/docs/guides/moderation)도
모델 신호와 애플리케이션 차단 정책을 구분한다.

## 4. 숨김 결정 연동 결과와 남은 차단 적용

- 팀 승인 정책을 명시한 테스트 환경에서 `HIDE_COMMENT`/`NO_ACTION` 결정을
  moderation:content-decisions에 발행하는 흐름을 검증했다.
- 운영 설정은 `MODERATION_CONTENT_ENFORCEMENT_ENABLED=false`. 승인 정책은 기본값이 없다.
  enabled=true에 정책이 없거나 문법·카테고리가 잘못되면 시작을 거부한다.
- 규칙은 팀이 명시한 category boolean에만 적용한다. global flagged 또는 임의 점수
  임계값으로 결정하지 않는다. 같은 정책 버전의 규칙 변경은 fingerprint로 거부한다.
- 모델 대기 중 관측한 새 버전/삭제/게시물 종료는 이전 결과의 새 결정 발행을 막는다.
  탐지 사실은 유지한다. 발행된 과거 결정의 회수나 미도착 이벤트 인지는 보장하지 않는다.
- 결과·결정 원문을 구분하고 결정 ID/sourceEventId/correlationId/activityVersion으로 추적한다.
  성공 로그는 **발행 성공**이며 실제 Post 차단 성공을 주장하지 않는다.
- **Post가 실제 콘텐츠를 숨기는 처리와 적용 피드백은 이번 범위에 없다.** 사용자 지시에 따라
  Post 변경은 포함하지 않았다. Post 팀의 소비자와 저장 모델·가시성 합의가 선행되어야 한다.

## 5. 검증 결과

Node 24.22.2 / pnpm 10.33.0. 격리된 로컬 Redis 7의 빈 테스트 DB를 사용했으며
운영 데이터나 기존 개발 Redis를 초기화하지 않았다.

| 검증 | 결과 |
| --- | --- |
| Moderation 단위/HTTP/OpenAPI 전체 | 15파일, 87개 통과 |
| Moderation Redis 통합 전체 | 84개 통과, opt-in 재시작 2개 skip (큰 버전 경계 테스트 추가 전) |
| 최종 결정 통합 테스트 | 16개 통과. 큰 safe integer 버전 보존 포함 |
| 최종 정책 단위 테스트 | 17개 통과 |
| 실제 OpenAI smoke | 2개 통과: 한국어 7사례와 기존 영어/실제 Redis 검사·ACK 경로 |
| typecheck / build | 통과 |
| 포맷 | 루트 format 실행 후 범위 밖 변경 복원. 마지막 수정은 Moderation 파일만 format/check |
| lint | 서비스에 별도 lint script 없음 |
| Post 실제 숨김·조회 비노출 E2E | 미실행: Post 소비·가시성/피드백 계약 미구현, 이번 범위 밖 |
| 운영 AOF/failover·GCP 배포 | 미실행 |

검증 사례: 정상/유해 결정, 기본 OFF, 정책 누락/잘못된 설정, 원문 미포함,
중복 입력·동시 발행, 새 수정 결과가 먼저 완료, 과거 이벤트 재전달, 댓글 삭제·Post
삭제/만료 경합, OpenAI 장애, Redis 연결 불가·잘못된 TYPE, XADD 런타임 실패,
응답 유실·ACK 유실·pending 재처리, 정책 버전 재사용, 최대 safe integer 버전 보존.
전체 회귀에는 기존 Lifecycle·신고·검사 결과 발행 테스트가 포함된다.

재현 명령은 services/moderation-service에서 `pnpm test`, `pnpm typecheck`,
`pnpm build`, `pnpm test:integration`이다. 통합 실행 전
MODERATION_TEST_REDIS_URL을 전용 빈 로컬 테스트 DB로 지정한다. 실제 모델 smoke는
기존 키를 프로세스에 로드한 뒤 `pnpm test:openai-smoke`를 실행한다.
키가 없으면 2개 smoke는 skip하며 mock 통과를 실제 모델 검증으로 보고하지 않는다.

## 6. 운영 설정·배포 선행 작업

1. 기능은 계속 OFF로 둔다. 팀 정책 카테고리·승인 버전과 오탐 허용 기준을 먼저 확정한다.
2. Post 소비·숨김 모델·버전 CAS·정책 허용 목록·영속 적용 receipt·결과 피드백을 합의하고 구현한다.
3. staging에서 실제 Post 비노출/실시간/Notification 경계까지 E2E를 수행한다.
4. 그 이후에만 승인된 정책 JSON과 enabled=true를 배포 설정으로 공급한다.
   이번 변경에는 운영 설정 활성화나 배포가 없다.
5. 단일 Redis primary/DB, ACL/TLS, noeviction, AOF/백업/RPO, 새 receipt·tombstone
   보존·정리·용량·Stream replay/trim 정책을 정한다. Redis Cluster는 현재 Lua 계약으로 지원하지 않는다.
6. OpenAI·Redis 장애, 결정 발행 실패, input pending/DLQ, Post 적용 실패·stale 거부를
   각 단계별로 감시한다. 오래된 완료 입력을 새 정책으로 자동 재결정하지 않는다.

## 7. Post·FE 인계

Post 팀은 [본문/버전 요청](contracts/post-content-contract-request.md)과
[결정 소비 계약](contracts/content-enforcement-events.md)을 검토해야 한다.
게시글 본문/변경 버전 제공, 숨김과 삭제의 의미, 원본 버전 검증, 적용 결과 피드백이 필요하다.
기존 삭제 함수를 숨김에 임의 매핑하거나, NO_ACTION을 재노출 명령으로 처리하면 안 된다.

FE에는 현재 API 변경이 없다. 향후 Post 숨김 상태·실시간 전파 계약이 정해지면
비노출/안내 화면, 수정 후 재검사 중 표시, 실제 적용 지연 UX를 함께 확인한다.
검사 flagged나 결정 발행만으로 삭제 완료를 표시하지 않는다.

push, PR 생성, merge, 운영 배포는 수행하지 않는다.
