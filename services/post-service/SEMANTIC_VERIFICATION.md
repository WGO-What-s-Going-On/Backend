# 유사 게시물 검색 기반 검증 결과

검증일: 2026-10-06. Node.js 24.21.0 / pnpm 10.33.0.

## 완료 범위

- Post `POST /api/v1/posts/similar`: 생성 입력 검증·기존 인증, 기본 5/limit 1–10, 350m·최근 24시간·최대 200개 후보, 유사도/거리/ID 정렬, MongoDB 최종 상태·본문 해시 재확인, partial/503 계약.
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

실제 모델은 연결하지 않았다. 일반 실행은 추천 503 `SIMILARITY_CHECK_UNAVAILABLE`, 검색 Worker 미실행이다. 기존 생성·조회·health는 정상 동작하며 MongoDB posts 스키마/공개 batch-get 최대 100개는 그대로다.

fixture를 환경 변수로 운영 모델로 선택하는 경로는 없다. `pnpm semantic:fixture`는 테스트 suite에서만 fixture를 주입하고 테스트용 데이터를 적재한다. 실제 모델 연결 시 `createEmbeddingProvider()`를 교체하고 평가한 `SEMANTIC_THRESHOLD`를 설정해야 한다. 한국어 의미 품질·모델 다운로드/ONNX·학습·양자화·추론 부하/성능·운영 사용자 인증 개방은 검증하지 않은 후속 범위다.

실행/복구 절차는 [README](README.md), 상세 HTTP·이벤트·인덱스 계약은 [검색 계약](contracts/semantic-search.md)에 있다. 테스트에 사용한 선택적 로컬 ES 컨테이너는 실행 상태로 남겼다.
