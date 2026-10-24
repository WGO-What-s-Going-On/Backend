# 변경 영향 기준 CI

`CI` 워크플로는 `scripts/ci-services.json`의 7개 애플리케이션과 명시된 계약 의존성을 기준으로 검증한다.
새 애플리케이션에 `package.json`을 추가하면 이 목록도 갱신해야 한다. 미등록 서비스는 감지 단계에서 실패한다.

## 비교 기준과 실행 범위

- PR 생성(`opened`)·추가 커밋(`synchronize`)·재오픈(`reopened`) 때만 실행한다. 일반 push, PR 닫기, 수동 실행은 트리거하지 않는다.
- PR base와 검사할 HEAD의 merge-base부터 비교한다. base 브랜치에만 추가된 변경은 포함하지 않는다.
- 삭제와 서비스 간 파일 이동은 이전·새 경로를 모두 검사한다.
- 문서만 변경하면 서비스 작업을 생략하지만, 인증·이벤트 계약 문서는 관련 소비자를 검사한다.
- 테스트만 변경하면 해당 서비스 검증만 수행하고 이미지 배포 후보에 포함하지 않는다.
- 공통 런타임 `packages/`, `shared/` 변경은 모든 서비스를 검사·배포 후보에 포함한다. 현재 도입되지 않은 공통 패키지의 미래 의존성을 추측하지 않기 위한 보수적 규칙이다.
- 공통 CI/포맷/패키지 설정 변경은 전체 검증이지만 애플리케이션 재배포를 강제하지 않는다.

감지 결과는 서로 다른 두 집합이다.

| 출력 | 용도 |
| --- | --- |
| `matrix`, `has_services` | 변경 서비스와 영향을 받는 계약 소비자 검증 |
| `deploy_matrix`, `has_deploy` | 실제 런타임·이미지 입력이 달라진 서비스 후보 |
| `integration_user_gateway` | 실제 HTTP Gateway→User 인증 회귀 검증 |
| `integration_ws_post` | 실제 WS→Post 참여/댓글 및 Map 위치 정책 회귀 검증 |

소비자 테스트를 실행했다는 이유만으로 소비자를 배포하지 않는다. CD는 동일한 선택 함수를 사용하되 **환경별 서비스의 마지막 성공 배포 커밋**과 비교하므로 이전 실패·취소로 남은 변경도 처리한다.

## 검증 작업

서비스별로 고정 lockfile 설치 → 정의된 typecheck/lint → 단위·저장소 통합 테스트 → build 순서로 실행한다.
런타임 변경 서비스는 Dockerfile 빌드도 확인한다. 현재 lint 명령이 없는 패키지에는 임의 도구를 추가하지 않는다.

`scripts/ci-compose.yaml`은 CI 작업에 필요한 저장소만 실행한다. User는 PostgreSQL·Redis,
Post는 MongoDB replica set·Redis·Cassandra·Elasticsearch, Map은 Cassandra·Redis, Notification은 DynamoDB Local·Redis,
Moderation과 Gateway는 해당 테스트의 Redis를 사용한다. 로컬 Compose 볼륨과 애플리케이션 컨테이너는 사용하지 않는다.
각 GitHub 작업은 별도 runner이며 Compose 프로젝트 이름에 run ID·attempt·service를 포함한다. 종료 시 해당 프로젝트만 정리한다.

- User→Gateway 교차 검증: HTTP·WS Gateway 빌드를 준비한 후 `RUN_GATEWAY_INTEGRATION=1`로 User 인증 통합 테스트를 실행한다. 실제 User 발급 토큰으로 HTTP API와 운영 설정 WS handshake(헤더·쿠키)를 함께 검증한다. 외부 Kakao 응답은 fixture이며 실제 OAuth 제공자를 호출하지 않는다.
- WS→Post 교차 검증: WS·Map 빌드를 준비한 후 Post 통합 테스트에 `RUN_WS_INTEGRATION=1`, `RUN_INTEGRATION=1`을 적용한다. Post 종료·삭제 Outbox → Redis → WS 전달도 test/ws-lifecycle.integration.test.ts에서 검사한다. 실제 WebSocket/HTTP/gRPC 경로와 Map 판정 코드를 사용하지만 Map 위치 저장소는 fixture다. 별도의 Map 서비스 테스트에서 Cassandra·Redis 동작을 검사한다.
- Post 검증은 Map 의존성 설치·빌드를 먼저 수행하고 Cassandra 스키마를 초기화한 뒤 semantic 통합 테스트를 실행한다. MongoDB·Redis·Cassandra·Elasticsearch와 Map gRPC는 실제 구현을 사용하며 임베딩 모델만 fixture로 대체한다. 외부 모델 다운로드·실제 OpenAI/FCM 호출 등 별도 자격 증명과 비용이 필요한 smoke test는 자동 실행하지 않는다.

모든 PR에서 고정 이름의 `ci` 최종 체크를 유지한다. 검증 실패·취소·감지 실패는 차단하며,
변경이 없어 정상적으로 생략된 서비스 작업만 허용한다. 브랜치 보호 required check는 동적 서비스 이름 대신 `ci`를 사용한다.

## 로컬 확인

```bash
node --test scripts/ci.test.mjs
node scripts/ci.mjs detect <base-sha> HEAD --pr
node scripts/ci.mjs format <base-sha> HEAD --pr
docker compose -f scripts/ci-compose.yaml config --quiet
```

직접 저장소 통합 테스트를 실행할 때는 테스트 포트가 비어 있는 격리 환경을 사용한다.
`node scripts/ci-dependencies.mjs start <service>` / `stop <service>`는 CI 전용 컨테이너를 관리하며,
애플리케이션 테스트가 사용하는 Redis 테스트 DB를 초기화할 수 있으므로 기존 개발 저장소와 공유하지 않는다.

## 병합 전 필수 설정

main Ruleset/branch protection에서 `ci` 체크 성공과 PR을 통한 병합을 필수로 지정한다.
최신 main을 반영한 PR 검증도 요구해 병합 후 조합이 미검증 상태가 되지 않게 한다.
이 저장소 변경은 GitHub 보호 규칙 자체를 생성하지 않는다. CD는 병합 이벤트에 연결되며
별도의 push CI를 기다리지 않는다. merge queue는 현재 트리거 범위에 포함하지 않는다.
