# 로깅 변경 검증

2026-11-04, Node 24.21.0 및 저장소 lockfile 기준으로 실행했다.

## 로컬 CI 진입점

- `node --test scripts/*.test.mjs`: 84개 통과. 공통 로그 개인정보 제외, ALS 격리, 로그 수준 및 복제본 일치 포함.
- `node scripts/gke-validate.mjs`: 59개 리소스 중 스키마 대상 46개 유효, 오류 0개, 외부 CRD 13개 제외.
- Map RPC 계약 복제본 diff: 차이 없음.
- `npm run format`: 실행 후 관련 변경만 남긴 것을 확인.
- 모든 서비스에 `node scripts/ci-run.mjs <service> install` 및 `node scripts/ci-run.mjs <service>` 실행. 해당 서비스의 typecheck, 정의된 lint, 테스트, build 통과.
- 7개 서비스에 CI와 같은 `docker build <service-path>` 실행: 모두 통과.

| 서비스 | 테스트 통과 | 조건부 제외 |
| --- | ---: | ---: |
| HTTP Gateway | 90 | 1 |
| WS Gateway | 62 | 0 |
| User | 509 | 4 |
| Post | 278 | 13 |
| Map | 91 | 0 |
| Notification 기본 / 통합 | 77 / 79 | 0 / 1 |
| Moderation 기본 / 통합 | 70 / 69 | 0 / 2 |

별도 계약 통합 검증:

- User `RUN_GATEWAY_INTEGRATION=1 pnpm exec vitest run test/auth.integration.test.ts`: 63개 통과.
- Post `RUN_INTEGRATION=1 RUN_WS_INTEGRATION=1 pnpm exec vitest run test/post.integration.test.ts test/ws-lifecycle.integration.test.ts test/map-budget.integration.test.ts`: 34개 통과.

조건부 제외 항목은 CI에서도 별도 플래그를 켜지 않는 실제 embedding model, 일부 전체 서비스 E2E·재시작 시나리오 등을 포함한다. 별도 계약 작업에서 수행한 항목은 위에 구분했다. 운영 GKE에 배포하거나 실제 공급자 API로 검증하지 않았다.

## 격리와 리뷰

기존 MongoDB·Redis·PostgreSQL·Cassandra·Elasticsearch 이미지를 재사용했다. `wgo-ci-logging-20261104-1-*` Compose 프로젝트를 만들었으며 각 검증 종료 시 정리했다. 최종 확인에서 작업 컨테이너가 남아 있지 않았다. 기존 이미지와 사용자 `.gitignore` 변경은 유지했다.

독립 리뷰에서 기본 DEBUG 출력량, Gateway correlation 누락, 재시도 한도에서의 `retryable` 값, 알림 식별자에 포함된 수신자 ID를 확인하고 수정했다. 성공 로그는 커밋 뒤에 기록하며, 트랜잭션 재시도·롤백 시 출력 결과를 테스트했다. 추가 주석은 저장 경계·외부 드라이버 재시도·개인정보 제외 이유를 설명하는 범위로 검토했다.
