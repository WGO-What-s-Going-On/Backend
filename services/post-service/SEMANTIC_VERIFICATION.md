# 유사 게시물 검색 기반 검증 결과

검증일: 2026-10-06. Node.js 24.21.0 / pnpm 10.33.0.

최신 검증은 마지막 **실제 E5 모델 연결 검증** 절을 기준으로 한다. 앞의 72개/75개 테스트 결과는 모델 연결 이전 단계의 기록이다.

## 완료 범위

- Post `POST /api/v1/posts/similar`: 생성 입력 검증·기존 인증, 기본 5/limit 1–10, 150m·최근 24시간·최대 200개 후보, 유사도/거리/ID 정렬, MongoDB 최종 상태·본문 해시 재확인, partial/503 계약.
- Map `MapPostQuery.SearchNearbyPosts`: ES256 Post 전용, 반경 150/250/350, limit 1–200, truncated. 기존 HTTP 100개/커서 및 MapAuthorization 호환성 유지.
- 모델 포트·384차원 검증·공유 정규화/해시·ES HTTP 어댑터·mapping/별칭. 별칭 누락 시 require_alias로 잘못된 인덱스 자동 생성 차단.
- Post 검색 Consumer Group/DLQ, 중복 벡터 재사용, 최신 원본 기준 제거, Pending/XAUTOCLAIM/5회 재시도, DLQ 성공 후 ACK, 전역 동시성 1.
- 원본 backfill/rebuild, 소비 lease, Stream watermark, 따라잡기, 양방향 검증과 별칭 교체. XTRIM이 max-deleted-entry-id를 갱신하지 않는 실제 동작을 재현하여 누적 발행 수와 재생 수 비교도 적용.
- 통합 테스트 종료 중 재현된 기존 Outbox Worker 경합도 수정: MongoDB 종료 전에 진행 중인 발행을 기다리고 새 wakeup을 차단. 이벤트 envelope/트랜잭션 계약은 유지.

## 실행 결과

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| 저장소 루트 | `npm run format` | 완료, 무관한 포맷 변경 없음 |
| 저장소 루트 | `npm run format:check` | 통과 |
| 저장소 루트 | `git diff --check` | 통과 |
| Post | `pnpm typecheck` | 통과 |
| Post | `pnpm build` | 통과 |
| Post | `RUN_INTEGRATION=1 RUN_SEMANTIC_INTEGRATION=1 pnpm test` | 10개 파일, 72개 테스트 통과, skip/미처리 오류 없음 |
| Map | `pnpm typecheck` | 통과 |
| Map | `pnpm build` | 통과 |
| Map | `RUN_INTEGRATION=1 pnpm test` | 5개 파일, 35개 테스트 통과 |
| Post CLI | `pnpm semantic:command backfill`, `pnpm semantic:command rebuild` | 모델 미연결 오류로 예상대로 exit 1, 외부 연결/데이터 변경 전에 종료 |

Post와 Map에는 별도 lint script가 없다. 존재하지 않는 lint 검사를 통과했다고 간주하지 않는다. 저장소 루트에는 단일 통합 테스트 명령이 없어 영향을 받는 두 서비스의 기존 통합 suite와 새 전체 연동 suite를 실행했다. HTTP Gateway 코드/계약은 변경하지 않았다.

Post 기존 롤백 테스트가 출력하는 `outbox unavailable`은 의도적으로 주입한 오류 로그이며 최종 테스트 실패나 미처리 오류가 아니다.

## 실제 저장소 검증

MongoDB replica set(:27017), Redis(:6380/:6381), Cassandra(:9042), 실제 Map gRPC 서버, Elasticsearch 8.19.4(:9200)를 사용했다. 임베딩만 테스트 포트로 주입했다.

- 201개 게시물을 실제 생성 API·MongoDB/Outbox·Redis Streams를 통해 적재. Map 공간 인덱스와 Post 벡터 인덱스에 소비.
- 200번째 후보의 높은 점수가 최상위로 반환됨을 확인. 201번째 후보 제외와 CANDIDATE_LIMIT, 기본 5개 및 limit=1 확인.
- ES 문서 누락 시 INDEX_LAG, MongoDB 삭제 원본 제외 확인.
- ES 저장 후 ACK 전 중단 상태에서 XAUTOCLAIM으로 복구하고 벡터 재사용 확인.
- Nest에 주입한 fixture 모델로 실제 Worker를 시작하여 누락 문서 복구 확인.
- Stream에 없는 오래된 원본 복구, 스캔 중 발생한 이벤트 따라잡기, 삭제 문서 제거, 새 물리 인덱스 별칭 전환 확인.
- 재구축 중 XTRIM으로 이벤트가 사라지면 검증 실패하고 기존 별칭이 유지됨을 확인.
- 단위/HTTP 경계 테스트로 잘못된 벡터·버전, 인증·입력, 동일 점수 정렬, 원본 상태/시간/해시 변경, ES shard 실패/timeout, 의존성 오류, DLQ 기록 실패 시 미ACK 검증.

## 실행 제한과 후속 단계

기반 구현 당시 실제 모델은 연결하지 않았다. 이후 E5 모델 연결을 완료했으며 아래 최신 검증 절에 기록했다. 모델 파일 누락/비활성/로딩 실패 시에는 추천 503·Worker 미실행을 유지한다. 기존 생성·조회·health와 MongoDB posts 스키마/공개 batch-get 최대 100개는 그대로다.

fixture를 환경 변수로 운영 모델로 선택하는 경로는 없다. `pnpm semantic:fixture`는 테스트 suite에서만 fixture를 주입하고 테스트용 데이터를 적재한다. 한국어 의미 품질·운영 임계값·학습·양자화·ECS 추론 부하/성능·운영 사용자 인증 개방은 후속 범위다.

실행/복구 절차는 [README](README.md), 상세 HTTP·이벤트·인덱스 계약은 [검색 계약](contracts/semantic-search.md)에 있다. 테스트에 사용한 선택적 로컬 ES 컨테이너는 실행 상태로 남겼다.

## Map gRPC 커서 연결 검증 (2026-10-06)

구현 범위는 Map gRPC·Post 클라이언트 연결이다. 일반 목록 HTTP API는 추가하지 않았다. 기존 SearchNearbyPosts에 cursor(요청 필드 5)·next_cursor(응답 필드 3)를 추가하고, Map의 기존 공간 조회와 커서를 그대로 사용한다. 기존 응답 필드와 ES256 인증은 유지한다. Post page()는 다음 페이지를 요청할 수 있으며 search()는 150m 첫 페이지 최대 200개만 비교한다.

Post 전체 통합 테스트 11개 파일·75개, Map 전체 통합 테스트 5개 파일·40개가 통과했다. 실제 Redis/Cassandra 공간 조회에서 gRPC로 200개 이후의 1개를 이어 받고, 중복 없는 201개와 마지막 nextCursor=null을 확인했다. 다른 좌표·반경에 커서를 재사용하면 INVALID_ARGUMENT이며, 잘못된 커서·빈 결과·구 서버 응답 호환성도 검증했다. 양 서비스 typecheck/build, 루트 format/format:check 및 git diff --check도 통과했다. 별도 lint script는 없다.

## 실제 E5 모델 연결 검증 (2026-10-06)

- 모델: Xenova/multilingual-e5-small revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, CPU FP32, Transformers.js 3.8.1 / ONNX Runtime 1.21.0, intra/inter-op 스레드 각 1. Mac arm64에서 검증했다.
- 모델 파일/토크나이저 checksum 검증, 네트워크 없는 로딩·워밍업, 단일 모델·큐, 480토큰 창/64토큰 중첩, 평균·L2 정규화를 연결했다.
- 짧은 한국어 입력은 같은 ONNX 모델의 공식 Transformers.js feature-extraction 파이프라인과 좌표별 오차 1e-5 미만이다. 초기 접두사 토큰화의 단독 공백 차이를 이 검사로 발견해 수정했다. Python 원본 모델과의 별도 비교는 수행하지 않았다.
- 5,000자 범위 장문에서 마지막 문장 변경이 벡터에 반영되고 벡터가 유한한 384차원 단위 벡터임을 확인했다. 이 검사는 한국어 중복 판별 정확도를 입증하지 않는다.
- 큐 상한·대기 timeout·대기 취소·실행 중 취소 후 슬롯 유지·인덱싱 공정성·비활성/로딩 실패·일회 초기화/해제·비동기 준비 후 Worker 시작·준비 중 종료를 테스트했다.
- 실제 MongoDB/Redis/Cassandra/Map gRPC/ES와 E5 Provider로 새 물리 인덱스 재구축·별칭 전환, 추천 HTTP 200/limit=1/150m, 새 버전 Worker의 누락 문서 복구를 확인했다. 테스트 임계값은 운영 평가 결과가 아니다.

| 명령 | 결과 |
| --- | --- |
| `RUN_INTEGRATION=1 RUN_SEMANTIC_INTEGRATION=1 RUN_EMBEDDING_MODEL=1 pnpm test` | 13개 파일, 88개 테스트 통과, skip 없음 |
| `pnpm semantic:model:test` | 실제 모델 3개 테스트 통과 |
| `pnpm semantic:model:prepare` | 기존 다운로드 파일 재사용·고정 checksum 검증 통과 |
| 모델 경로를 존재하지 않는 경로로 지정한 `pnpm semantic:command backfill` | 모델 준비 단계에서 exit 1, DB/Redis 연결·데이터 변경 전에 종료 |
| `pnpm typecheck`, `pnpm build` | 통과 |
| 루트 `npm run format`, `npm run format:check`, `git diff --check` | 통과, 무관한 변경 없음 |

별도 lint 명령은 없다. 이번 변경은 Post 내부 모델 연결이며 Map 코드는 변경하지 않았다. 모델이 준비되어도 `SEMANTIC_THRESHOLD` 미설정 시 추천은 503이다. 실제 데이터의 재인덱싱과 운영 활성화는 [README](README.md)의 새 모델 별칭·backfill 절차를 따른다.
