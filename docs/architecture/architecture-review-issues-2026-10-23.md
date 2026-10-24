# WGO 아키텍처 개선 이슈 목록

현재 MSA의 서비스 분리는 유지하되, 인증·인가와 서비스 간 상태 변경 연결을 먼저 완성한다. 이후 Map 검색의 정확성과 조회량, 비동기 작업의 처리 범위, 검증 체계를 개선한다. 모든 서비스를 동일한 MVC 또는 DDD 계층으로 재작성하는 것은 목표가 아니다.

- 검토일: 2026-10-23
- 기준 브랜치: `test/infra-setup`
- 기준 커밋: `4104986a7a9f12f13cd451043a78cb561d7b1f75`
- 범위: HTTP Gateway, WS Gateway, User, Post, Map, Notification, Moderation 및 관련 계약·CI
- 상태: 모든 항목 미해결. 이 문서의 ID는 내부 추적용이며 GitHub Issue 생성이나 담당자 배정을 의미하지 않는다.
- 기준: [전체 아키텍처](../../ARCHITECTURE.md), [프로젝트 지침](../../AGENTS.md), [서비스 인증 계약](../contracts/service-authentication.md)

## 우선순위와 완료 관리

| 우선순위 | 적용 기준                                                  |
| -------- | ---------------------------------------------------------- |
| P0       | 즉시 조치. 해당 경로를 운영에 공개하기 전에 차단 또는 수정 |
| P1       | 관련 기능의 운영 공개 또는 확장 전에 해결                  |
| P2       | 후속 개선. 부하·운영 요구를 확인하여 적용 시점 결정        |

Critical과 High는 관련 기능의 병합·운영 공개 전 차단 이슈로 취급한다. Medium의 차단 범위는 각 항목에 별도로 명시한다. Suggestion은 측정·설계 검토 과제이며 확정된 결함과 구분한다.

상태는 `미해결 → 진행 중 → 검증 대기 → 해결`로 갱신한다. 해결 시 구현 PR 또는 커밋, 실행한 검증, 남은 제한을 해당 항목에 기록한다. 완료 체크리스트는 앞으로 충족할 조건이며 기존 구현이나 테스트 통과를 의미하지 않는다.

| ID          | 심각도     | 우선순위 | 해결할 이슈                                    | 관련 서비스                         | 상태   |
| ----------- | ---------- | -------- | ---------------------------------------------- | ----------------------------------- | ------ |
| WGO-ARCH-01 | Critical   | P0       | 공개 사용자 API의 신원 헤더 신뢰 제거          | HTTP Gateway, User                  | 미해결 |
| WGO-ARCH-02 | High       | P0       | WS 참여와 댓글 작성의 도메인 인가 연결         | WS Gateway, Post, Map               | 로컬 검증 완료 |
| WGO-ARCH-03 | High       | P1       | 사용자 JWT 발급과 운영 WS 검증 계약 통일       | User, HTTP Gateway, WS Gateway      | 미해결 |
| WGO-ARCH-04 | High       | P1       | Map 검색의 페이지 누락과 과도한 순차 조회 수정 | Map, Post                           | 미해결 |
| WGO-ARCH-05 | High       | P1       | Moderation 결정의 Post 원본 적용 연결          | Moderation, Post, Map, Notification | 미해결 |
| WGO-ARCH-06 | High       | P1       | 삭제·만료·댓글 삭제의 실시간 상태 반영         | WS Gateway, Post                    | 미해결 |
| WGO-ARCH-07 | Medium     | P1       | Notification 전송 재시도의 전체 스캔 제거      | Notification                        | 미해결 |
| WGO-ARCH-08 | Medium     | P1       | Moderation 전체 평가와 단일 JSON 증가 제한     | Moderation                          | 미해결 |
| WGO-ARCH-09 | Medium     | P1       | WS 수신 큐와 송신 버퍼 상한 적용               | WS Gateway                          | 미해결 |
| WGO-ARCH-10 | Medium     | P1       | 투표 후보 선정의 전체 댓글 조회 제한           | Post                                | 미해결 |
| WGO-ARCH-11 | Medium     | P1       | CI 타입·빌드·통합·소비자 계약 검증 보강        | 전체, CI                            | 미해결 |
| WGO-ARCH-12 | Medium     | P1       | 데이터 소유권과 저장소 기준 문서 정합성 확보   | 전체                                | 미해결 |
| WGO-ARCH-13 | Medium     | P2       | 복잡한 업무 규칙과 저장소 구현의 결합 완화     | Post, Notification, Map             | 미해결 |
| WGO-ARCH-14 | Medium     | P1       | 요청과 후속 이벤트의 Correlation ID 연결       | HTTP Gateway, Post, 이벤트 소비자   | 미해결 |
| WGO-ARCH-15 | Suggestion | P2       | 온라인 추론과 인덱싱 자원 경합 측정            | Post                                | 미해결 |

## 운영 공개 전 차단 이슈

### WGO-ARCH-01 공개 사용자 API의 신원 헤더 신뢰 제거

**심각도 Critical · 우선순위 P0 · 인증 경로 공개 차단**

HTTP Gateway가 외부 요청의 `X-User-Id`를 그대로 전달하고, User Controller는 형식만 확인한 뒤 사용자 신원으로 사용한다. 사용자 Bearer 검증이나 운영 환경 차단이 없어 다른 사용자 ID로 프로필 조회·수정, 약관 동의, 탈퇴를 요청할 수 있다.

격리 재현에서는 `NODE_ENV=production`, 인증 토큰 없음, `X-User-Id: 42` 조건으로 `POST /api/v1/users/me/withdrawal`을 호출했다. 실제 Gateway와 User Controller를 통과해 사용자 42의 탈퇴 서비스가 호출되고 200이 반환됐다. DB 변경 서비스는 Mock으로 대체했으며 실제 계정은 변경하지 않았다.

근거: [Gateway 헤더 전달](../../gateways/http-gateway/src/app.ts) 198행, [User 탈퇴 Controller](../../services/user-service/src/users/users.controller.ts) 234행.

해결 방향은 외부 신원 헤더 제거, 사용자 토큰 검증, 인증된 내부 호출 문맥 전달이다. User도 내부 호출자와 사용자 문맥을 검증해야 한다. 연결 전에는 보호 대상 운영 API를 닫는다.

- [ ] 토큰 없이 신원 헤더만 보낸 요청은 거부한다.
- [ ] 사용자 A의 토큰과 사용자 B의 헤더를 함께 보내도 B의 데이터에 접근하지 못한다.
- [ ] User 직접 접근도 내부 호출자 인증을 우회하지 못한다.
- [ ] 프로필·약관·탈퇴·로그아웃 등 신원 헤더를 사용하는 경로를 함께 점검한다.
- [ ] 정상 사용자 요청과 만료·변조·잘못된 issuer/audience 요청을 Gateway부터 검증한다.

### WGO-ARCH-02 WS 참여와 댓글 작성의 도메인 인가 연결

**심각도 High · 우선순위 P0 · 위치 기반 참여 기능 공개 차단**

HTTP의 `JoinPost`는 Map 위치 판정을 사용하지만 WS의 `canJoin()`은 사용자 ID를 사용하지 않고 Post의 ACTIVE 상태만 조회한다. Room 가입 후 댓글 작성에서도 Post의 `CreateComment`는 위치나 영속 참여 상태를 확인하지 않는다. 따라서 유효한 토큰과 게시물 ID가 있으면 위치 제한을 거치지 않는 참여·작성 경로가 존재한다.

서로 다른 사용자에 대해 동일한 상태 조회만 수행하고 참여를 허용하는 동작을 어댑터 재현으로 확인했다.

근거: [WS Post Client](../../gateways/ws-gateway/src/realtime/post-client.ts) 68행, [Post 작성·참여 유스케이스](../../services/post-service/src/post/application/commands.ts) 102행 및 `JoinPost`.

Post가 소유하는 공통 참여 인가 유스케이스를 HTTP와 WS가 사용하도록 연결한다. Room 가입은 도메인 참여 허가 이후의 연결 상태로 관리한다. 댓글 작성에 필요한 참여·위치 최신성 정책도 Post 계약에서 명확히 한다.

- [x] 위치 없음·오래된 위치·반경 밖 사용자의 참여를 HTTP와 WS 모두 거부한다.
- [x] 비활성 게시물 및 인가 의존성 장애에서 참여를 허용하지 않는다.
- [x] Post 내부 댓글 API를 직접 호출해 참여 정책을 우회하지 못한다.
- [x] 정상 참여, 재참여, 재연결, 중복 댓글 요청의 동작을 검증한다.
- [x] Gateway에 도메인 정책을 복제하지 않고 Post에서 최종 인가한다.

**2026-10-24 구현·검증:** WS는 ES256 인증 내부 참여 HTTP API를 통해 기존 Post `JoinPost`를 호출한 뒤
Room을 등록한다. 신규 댓글은 활성 참여 및 Map 위치 판정을 통과해야 하며 기존 mutation 재시도는
중복 쓰기를 하지 않는다. Room 용량·인가 중 연결 종료·재연결도 검증했다.
Post 129개 및 WS 18개 테스트가 통과했으며 실제 WS→Post→Map RPC와 위치 정책 연결을 포함한다.
해당 통합 테스트의 위치 저장소는 fixture이며 실제 Cassandra 검증과 AWS 배포는 별도다.
운영 공개에는 서비스 키 주입과 WGO-ARCH-03 사용자 토큰 호환성 해결이 여전히 필요하다.

### WGO-ARCH-03 사용자 JWT 발급과 운영 WS 검증 계약 통일

**심각도 High · 우선순위 P1 · 로그인과 운영 WS 연동 공개 차단**

User는 HS256 Access Token을 발급한다. 운영 WS는 JWKS를 필수로 요구하고 RS256 또는 ES256만 허용한다. issuer와 audience를 맞춰도 서명 알고리즘이 호환되지 않는다. 실제 User 발급 토큰이 로컬 WS 검증은 통과하고 JWKS 검증 경로에서는 거부되는 것을 재현했다.

근거: [User 토큰 발급](../../services/user-service/src/auth/access-token.service.ts) 22행, [WS 토큰 검증](../../gateways/ws-gateway/src/realtime/authentication.ts) 47행, [WS 운영 설정](../../gateways/ws-gateway/src/config.ts).

사용자 토큰의 알고리즘·issuer·audience·필수 claim·키 배포 및 교체 계약을 통일한다. 사용자 인증과 서비스 간 호출자 인증은 구분한다. WGO-ARCH-01과 함께 설계하되, 계약 변경 시 기존 토큰의 전환 정책도 정한다.

- [ ] 실제 로그인으로 발급한 토큰으로 운영 설정의 WS 연결에 성공한다.
- [ ] HTTP Gateway도 동일한 사용자 토큰 계약을 검증한다.
- [ ] 키 교체 중 신·구 토큰의 허용 기간과 만료 동작을 검증한다.
- [ ] 잘못된 알고리즘·issuer·audience·만료 토큰을 거부한다.
- [ ] 계정 정지·탈퇴와 이미 연결된 소켓의 처리 정책을 명시한다.

### WGO-ARCH-04 Map 검색의 페이지 누락과 과도한 순차 조회 수정

**심각도 High · 우선순위 P1 · 검색 정확성 및 확장 차단**

GEO 후보 전체를 조회한 뒤 각 후보의 Cassandra 위치와 상태를 순차 조회하고, 전체 정렬 후 응답 limit을 적용한다. GEO 결과가 없으면 H3 Cell별 16개 Shard를 순차 조회한다. Cassandra 결과의 `pageState`는 소비하지 않는다.

저장소 어댑터 재현 결과는 다음과 같다. 실제 DB 응답 시간이나 처리량 측정값은 아니다.

| 조건                              | 관측 결과                                |
| --------------------------------- | ---------------------------------------- |
| GEO 후보 1,000개, 응답 limit 1    | Cassandra 조회 2,000회                   |
| 일반 지역의 빈 GEO 결과           | 19개 Cell × 16개 Shard = 304회 순차 조회 |
| Cassandra 응답에 다음 페이지 존재 | 후속 페이지를 읽지 않고 결과 반환        |

기준 버전 드라이버의 기본 페이지 크기는 5,000행이다. Cell·Shard가 이 크기를 넘으면 대체 검색에서 후속 페이지의 게시물이 누락될 수 있다. `posts_by_cell`에는 시간 버킷이나 TTL이 없고 종료 시 Cell 행을 정리하지 않아 누적 데이터도 검토해야 한다.

근거: [공간 검색](../../services/map-service/src/post-index.ts) 276행, [후보별 조회](../../services/map-service/src/post-index.ts) 361행, [공간 테이블](../../services/map-service/schema.cql) 40행.

먼저 저장소 페이지를 정확히 처리한다. 이후 제한된 동시성, 검색용 상태 사영, 활성 인덱스 정리 및 조회 범위 제한을 적용한다. 후보 수를 단순히 잘라 정확한 결과를 놓치지 않도록 추가 탐색·커서·부분 결과 정책을 함께 정한다.

- [ ] Cassandra 다중 페이지에서 활성 게시물이 누락되지 않는다.
- [ ] 같은 거리의 동률·비활성 후보·다음 페이지에서 중복과 누락을 검증한다.
- [ ] 빈 결과·Redis 장애·밀집 지역의 DB 호출 수와 응답 시간을 측정한다.
- [ ] 요청별 조회량과 동시성 상한, deadline 이후 작업 중단을 정의한다.
- [ ] Cell 데이터의 보존·정리·재구축 정책을 검증한다.
- [ ] 소비자인 Post 유사도 검색의 후보·부분 결과 계약을 회귀 검증한다.

### WGO-ARCH-05 Moderation 결정의 Post 원본 적용 연결

**심각도 High · 우선순위 P1 · 자동 제재 및 자동 종료 기능 공개 차단**

Moderation은 `BOARD_STALE`, `BOARD_REACTIVATED`, `BOARD_CLOSED`를 발행하지만 Post에 이를 적용하는 Consumer나 인가된 상태 변경 API가 없다. 댓글 검사 결과도 내부 저장에 머물러 실제 제재 적용까지 연결되지 않는다. Moderation의 CLOSED와 Post의 ACTIVE가 동시에 존재할 수 있다.

근거: [Moderation 연동 공백](../../services/moderation-service/contracts/integration-gaps.md) 27행 및 41행, [Lifecycle 처리](../../services/moderation-service/src/lifecycle/lifecycle.service.ts).

목표 흐름은 `판단 → Post 적용 요청 → 원본 버전 확인 및 원자적 변경 → 적용 성공/거부 이벤트 → 소비자 반영`이다. WGO-ARCH-12에서 일반 수명주기 정책의 소유권을 먼저 확정한다. CLOSED를 EXPIRED로 임의 매핑하지 않는다.

- [ ] 결정 ID·대상 버전·정책 버전·상태 매핑·실패 의미를 계약으로 확정한다.
- [ ] 중복·역순 결정과 이미 삭제·만료된 대상의 처리를 검증한다.
- [ ] 원본 상태 변경과 확정 이벤트 Outbox를 같은 로컬 트랜잭션으로 기록한다.
- [ ] Map과 Notification은 판단이 아닌 필요한 확정 사실을 반영한다.
- [ ] 판단부터 실제 게시물 상태 변경까지 종단 간 테스트를 통과한다.
- [ ] 게시물 본문 검사에 필요한 인가된 조회 또는 검사 요청 계약도 명시한다.

### WGO-ARCH-06 삭제와 만료의 실시간 상태 반영

**심각도 High · 우선순위 P1 · 실시간 상태 동기화 차단**

WS 이벤트 소비자는 생성 계열 4종을 전달하고 그 밖의 이벤트는 ACK한다. Post 삭제·만료·댓글 삭제가 기존 Room과 클라이언트 상태에 반영되지 않는다. 이것이 Post의 종료 후 쓰기 검증까지 모두 우회한다는 뜻은 아니지만, 연결 중 화면과 구독 상태는 오래된 상태로 남는다.

근거: [WS 이벤트 분기](../../gateways/ws-gateway/src/realtime/post-events.ts) 150행, [Room 관리](../../gateways/ws-gateway/src/realtime/subscription-manager.ts).

- [ ] 삭제·만료·댓글 삭제 및 필요한 반응 취소의 WS 메시지 계약을 정의한다.
- [ ] 종료 게시물의 기존 Room 처리와 클라이언트 통지 정책을 구현한다.
- [ ] 삭제 후 늦게 도착한 생성 이벤트가 클라이언트 상태를 되살리지 않도록 버전을 처리한다.
- [ ] 여러 Gateway 인스턴스에서 동일하게 반영되는지 검증한다.
- [ ] 재연결 후 원본 상태 조회로 누락 이벤트를 복구한다.

## 성능과 검증 개선 이슈

### WGO-ARCH-07 Notification 전송 재시도의 전체 스캔 제거

**심각도 Medium · 우선순위 P1 · 대규모 알림 운영 전 해결**

각 인스턴스가 30초마다 이벤트 상태 테이블을 스캔한다. 완료된 전송도 읽어 메모리에 모은 뒤 PENDING/SENDING만 필터링한다. 게시물별 처리 역시 해당 게시물의 전송 이력을 읽는다. 누적 이력과 인스턴스 수에 따라 읽기 비용과 메모리 사용이 증가한다. 현재 부하에서의 포화 임계점은 측정하지 않았다.

근거: [전송 작업 조회](../../services/notification-service/src/persistence/dynamodb-event.store.ts) 341행, [재시도 주기와 전송](../../services/notification-service/src/event-consumer/post-event.handler.ts) 31행.

- [ ] 상태·다음 시도 시각 기준으로 처리할 작업만 제한된 배치로 조회한다.
- [ ] 다중 인스턴스에서도 기존 lease·조건부 갱신의 중복 방어를 유지한다.
- [ ] 완료 작업과 이벤트 중복 방지 기록의 보존·재생 기간을 구분한다.
- [ ] 완료 이력이 늘어나도 재시도 1회 조회량이 전체 이력에 비례하지 않는지 검증한다.

### WGO-ARCH-08 Moderation 전체 평가와 단일 JSON 증가 제한

**심각도 Medium · 우선순위 P1 · 활성 게시물 및 활동량 확대 전 해결**

스케줄러가 모든 활성 게시물 ID와 상태를 `SMEMBERS`·`MGET`으로 읽는다. 댓글·반응은 게시물별 단일 JSON에 누적되고 변경마다 전체 상태를 읽고 직렬화해 CAS로 저장한다. 인스턴스마다 전체 평가도 반복한다. CAS가 중복 상태 변경을 보호하더라도 조회·직렬화 비용은 중복된다.

근거: [전체 상태 조회](../../services/moderation-service/src/lifecycle/redis-lifecycle.repository.ts) 49행, [스케줄러](../../services/moderation-service/src/lifecycle/lifecycle.scheduler.ts) 37행, [반응 누적](../../services/moderation-service/src/lifecycle/lifecycle.service.ts) 50행.

- [ ] 다음 평가 시각을 기준으로 필요한 게시물만 배치 조회한다.
- [ ] 작업 분담 또는 선점으로 인스턴스 수에 비례하는 전체 스캔을 줄인다.
- [ ] 관계별 버전 상태와 집계 상태를 분리하고 보존 범위를 정의한다.
- [ ] 역순·중복·삭제 tombstone·동시 CAS 관련 기존 보장을 유지한다.
- [ ] 큰 게시물 상태와 다중 인스턴스에서 메모리·처리 지연을 측정한다.

### WGO-ARCH-09 WS 수신 큐와 송신 버퍼 상한 적용

**심각도 Medium · 우선순위 P1 · 외부 트래픽 확대 전 해결**

소켓별 메시지를 Promise 체인에 계속 추가하며 대기 개수 상한이 없다. 송신에서도 `bufferedAmount`를 확인하지 않는다. payload 한 건의 크기 제한만으로 빠른 발신자와 느린 수신자의 누적 메모리를 제한할 수 없다.

근거: [수신 큐](../../gateways/ws-gateway/src/app.ts) 194행, [이벤트 송신](../../gateways/ws-gateway/src/realtime/post-events.ts) 208행.

- [ ] 연결·사용자별 메시지 빈도와 대기 작업 수를 제한한다.
- [ ] 송신 버퍼 임계치와 느린 수신자 종료 정책을 적용한다.
- [ ] 연결 종료 후 대기 중인 불필요한 작업을 중단한다.
- [ ] 정상 사용자는 계속 처리되는 동안 과도한 발신·느린 수신만 제한되는지 검증한다.

### WGO-ARCH-10 투표 후보 선정의 전체 댓글 조회 제한

**심각도 Medium · 우선순위 P1 · 대규모 게시물 투표 활성화 전 해결**

투표 후보 선정이 MongoDB 트랜잭션 안에서 활성 댓글 전체를 가져와 JavaScript로 정렬하고 상위 2개를 선택한다. 댓글 수가 커질수록 메모리와 트랜잭션 시간이 증가한다.

근거: [투표 후보 선정](../../services/post-service/src/post/infrastructure/mongoose-vote.ts) 60행.

- [ ] 점수와 동률 정렬 기준에 맞는 조회 모델·인덱스를 정한다.
- [ ] DB에서 필요한 후보만 제한하여 조회한다.
- [ ] 댓글 삭제·공감 변경과 후보 확정 사이의 기존 동시성 보호를 유지한다.
- [ ] 댓글 수 증가에 따른 조회 문서 수·메모리·트랜잭션 시간을 비교한다.

### WGO-ARCH-11 CI 검증 범위 보강

**심각도 Medium · 우선순위 P1 · 차단 이슈 수정 PR부터 적용**

현재 CI는 기본 Vitest를 실행하지만 typecheck·build 단계가 없다. Map·Post·Gateway의 여러 통합 테스트는 환경 플래그로 건너뛰고, Notification·Moderation 통합 테스트는 별도 설정을 사용한다. 변경 서비스 중심의 선택만으로 생산자 변경에 따른 소비자 호환성을 확인할 수 없다.

근거: [CI](../../.github/workflows/ci.yml) 77행, [변경 서비스 선택](../../scripts/ci.mjs), [Map 통합 테스트](../../services/map-service/test/post-index.integration.test.ts), [Notification 통합 설정](../../services/notification-service/vitest.integration.config.ts), [Moderation 통합 설정](../../services/moderation-service/vitest.integration.config.ts).

- [ ] 변경 서비스의 타입 검사와 빌드를 필수 검사에 추가한다.
- [ ] 계약 변경 시 관련 생산자·소비자 검증을 함께 실행한다.
- [ ] 실제 DB·Redis를 사용하는 핵심 통합 테스트를 실행한다.
- [ ] 인증, 위치 참여, 상태 종료 전파의 최소 종단 간 시나리오를 추가한다.
- [ ] 필수 테스트가 모두 skip된 실행을 성공으로 오인하지 않게 한다.
- [ ] 지침의 lint 요구를 실제 제공하는 검사 명령과 일치시킨다.

## 구조와 운영 기준 개선 이슈

### WGO-ARCH-12 데이터 소유권과 저장소 기준 문서 정합성 확보

**심각도 Medium · 우선순위 P1 · 상태 변경·저장소 계약 확정의 선행 과제**

상위 아키텍처는 보드 수명주기·참여를 Map 중심으로 설명하는 부분이 있지만 실제 원본 상태와 참여는 Post가 소유한다. Notification은 문서의 PostgreSQL 대신 DynamoDB를 사용하고 Moderation은 Redis를 사용한다. Post의 Elasticsearch·E5 검색 구성도 상위 설명과 함께 정리해야 한다.

근거: [전체 아키텍처](../../ARCHITECTURE.md) 4·6·7절, [Notification 저장소 연결](../../services/notification-service/src/notification/notification.module.ts) 30행, [Moderation 저장소](../../services/moderation-service/src/lifecycle/redis-lifecycle.repository.ts).

저장소 선택 자체를 결함으로 단정하지 않는다. 최종 원본·파생 사영·감사 기록·복구 원천을 명시하고 승인된 선택을 문서에 반영한다. 일반 비활성 종료 규칙을 Post 내부에 둘지, Moderation의 결정과 Post의 적용으로 나눌지도 확정한다.

- [ ] Post·Map·Moderation의 상태 및 참여 소유권을 하나의 기준으로 확정한다.
- [ ] 각 저장소의 원본 여부, 보존 기간, 유실 시 복구 원천을 명시한다.
- [ ] Moderation 결정·감사 데이터의 영속성 요구와 Redis 운영 정책을 일치시킨다.
- [ ] 구현 완료·계획·미연결 기능을 구분하고 오래된 상태 문서를 정리한다.
- [ ] 저장소 교체나 서비스 통합은 별도 요구·비용 평가 없이 추진하지 않는다.

### WGO-ARCH-13 복잡한 업무 규칙과 저장소 구현의 결합 완화

**심각도 Medium · 우선순위 P2 · 비차단 유지보수 개선**

Post의 주요 작성 기능은 application/domain/ports/infrastructure를 분리하지만 투표 Controller는 `MongooseVote`를 직접 호출한다. 이 클래스에 후보 선정·인가·트랜잭션·저장이 모인다. Notification의 `DynamoDbEventStore`에는 수신자·알림 묶음·취소 정책과 저장 로직이 함께 있고, Map의 `PostIndex`에는 검색·이벤트 반영·재구축이 모인다.

근거: [Post Controller](../../services/post-service/src/post/post.controller.ts) 107행, [투표 구현](../../services/post-service/src/post/infrastructure/mongoose-vote.ts), [알림 이벤트 저장](../../services/notification-service/src/persistence/dynamodb-event.store.ts), [Map 인덱스](../../services/map-service/src/post-index.ts).

변경·검증이 어려운 복잡한 규칙만 순수 정책 또는 유스케이스로 분리한다. User의 단순 CRUD에 불필요한 계층을 추가하거나 전체 서비스를 같은 구조로 바꾸지 않는다.

- [ ] 투표의 업무 규칙을 MongoDB 없이 검증할 수 있다.
- [ ] Notification 정책과 조건부 원자적 저장의 책임이 구분된다.
- [ ] Map 검색과 인덱스 쓰기·재구축의 테스트 경계가 명확하다.
- [ ] 기존 API·이벤트·트랜잭션·멱등성 동작을 유지한다.
- [ ] 실제 중복이나 복잡성 없이 기반 클래스·공유 도메인 패키지를 추가하지 않는다.

### WGO-ARCH-14 요청과 후속 이벤트의 Correlation ID 연결

**심각도 Medium · 우선순위 P1 · 운영 장애 추적 보완**

Gateway는 요청 ID를 전달하지만 Post 이벤트 생성은 매번 새 UUID를 Correlation ID로 사용한다. 따라서 한 HTTP 요청과 그 요청이 만든 Outbox·이벤트·소비 결과를 같은 식별자로 추적할 수 없다.

근거: [Gateway 요청 ID 전달](../../gateways/http-gateway/src/app.ts) 198행, [Post 이벤트 생성](../../services/post-service/src/post/application/event.ts) 16행.

- [ ] 요청에서 검증·정규화한 Correlation ID를 유스케이스와 Outbox에 전달한다.
- [ ] HTTP·gRPC·이벤트 소비 경계에서 같은 흐름을 추적할 수 있다.
- [ ] 재시도 시 eventId와 Correlation ID를 보존한다.
- [ ] 스케줄러 등 요청 없는 작업은 별도의 작업 문맥을 생성한다.
- [ ] 로그로 전달되는 식별자에 토큰·본문·불필요한 정밀 위치를 포함하지 않는다.

### WGO-ARCH-15 온라인 추론과 인덱싱 자원 경합 측정

**심각도 Suggestion · 우선순위 P2 · 측정 후 결정**

Post E5 추론은 인스턴스에서 한 작업씩 실행하고 온라인 검색과 백그라운드 인덱싱이 같은 큐를 공유한다. 큐 상한과 우선순위가 구현되어 있으므로 즉시 결함으로 판단하지 않는다. 검색량이나 인덱싱량이 커질 때 대기 시간·자원 경합이 목표를 넘는지 확인한다.

근거: [추론 큐](../../services/post-service/src/post/semantic/embedding-provider.ts) 110행, [검색 모듈 연결](../../services/post-service/src/post/semantic/semantic.module.ts).

- [ ] 온라인 검색 P95·큐 대기·큐 거절·인덱싱 지연·CPU·메모리를 측정한다.
- [ ] 목표와 측정 결과에 따라 현 구조 유지 또는 별도 Worker 배포를 결정한다.
- [ ] 분리 시 같은 Post 도메인 소유권과 모델·인덱스 버전 계약을 유지한다.
- [ ] 부하 근거 없이 별도 검색 마이크로서비스를 추가하지 않는다.

## 권장 실행 순서

### QA 결과를 반영한 통합 우선순위 — 2026-10-23

아키텍처 15개 항목과 [QA 확정 결함 7건](../../qa/artifacts/20261023-local-6975fb3/defects.md)을 함께 평가했다. QA의 부분 GEO 유실과 기본 500ms 후보 조회 실패는 모두 WGO-ARCH-04의 하위 작업으로 관리한다. 따라서 원본 기록은 22개이며, 이 두 건을 중복 작업으로 만들지 않으면 관리 대상은 20개다. 서로 다른 재현 조건과 완료 검증은 각각 유지한다.

이번 순서는 심각도와 별개인 **착수·완료 순서**다. 앞의 Critical/High/Medium 및 P0/P1/P2 판정은 유지한다. CI 보강과 소유권 합의를 앞당기는 이유는 다른 수정의 선행 조건이기 때문이다. QA 기준 `6975fb3`부터 현재 확인한 `bb1f151`까지 변경은 QA 문서와 `.gitignore`이며, 제품 코드 수정에 따른 해결은 확인되지 않았다. 아래 항목은 모두 미해결이다.

#### 1차: 즉시 착수 — 인증 경계, 외부 요청 제한, 수정 검증 기반

| 착수 순서 | 대상 | 먼저 처리할 이유와 완료 기준 |
| --- | --- | --- |
| 1 | **WGO-ARCH-01 + 03** | 신원 헤더 위조로 다른 사용자의 수정·탈퇴가 가능한 경로가 최우선이다. 미수정 경로는 먼저 운영 공개를 차단한다. 사용자 JWT 계약을 함께 정하고, 실제 User 로그인 토큰이 운영 HTTP/WS 검증을 통과하도록 구현한다. 위조 헤더·잘못된 토큰·내부 직접 호출 거부를 회귀 검증한다. |
| 선행 합의 | **WGO-ARCH-12** | 02의 참여 인가와 05의 상태 변경 전에 Post·Map·Moderation 소유권 및 상태 매핑을 확정한다. DynamoDB/Redis의 원본·복구 기준도 CD 인프라를 고정하기 전에 결정한다. 전체 문서 정리가 끝날 때까지 인증 차단을 미루지는 않는다. 저장소 교체를 자동으로 작업 범위에 넣지 않는다. |
| 2 | **WGO-ARCH-02** | WS Room 가입과 댓글 API가 위치·참여 인가를 우회한다. 12의 참여 정책을 바탕으로 Post가 최종 인가하고 HTTP/WS가 같은 규칙을 사용하도록 한다. 반경 밖·위치 만료·의존성 장애·내부 직접 호출과 재연결을 검증한다. |
| 3 | **QA-01 Gateway bodyLimit 우회** | 공개 진입점의 요청 크기 제한이 작동하지 않는다. 고정 길이와 chunked 요청 모두에서 설정 한도를 강제하고, 초과 본문 전체가 upstream에 전달되지 않는지 확인한다. |
| 첫 수정 PR부터 병행 | **WGO-ARCH-11 + QA-01 Gateway 표준 start 실패** | 타입 검사·빌드·기동 smoke를 먼저 추가하고 start 경로를 바로잡는다. 이후 각 수정에 필요한 실제 저장소 통합 테스트와 생산자·소비자 계약 테스트를 필수 검사로 편입한다. 기본 Vitest 성공이나 skip만으로 배포를 허용하지 않는다. |

Gateway start 실패는 `pnpm build && pnpm start`에서 확인됐다. Dockerfile은 실제 산출물인 `dist/src/server.js`를 직접 실행하므로 이 결함만으로 ECS 컨테이너도 기동 실패한다고 판정하지 않는다. CD에서는 실제 이미지의 기동·readiness를 별도로 검증해야 한다.

#### 2차: 관련 기능 운영 공개 전 — 검색, 상태 적용, 장애 전파

| 기본 순서 | 대상 | 의존 관계 및 완료 기준 |
| --- | --- | --- |
| 4 | **WGO-ARCH-04 + QA-08 부분 GEO 유실 + QA-09 기본 deadline 실패** | 위치 기반 핵심 기능에서 실제 검색 누락과 HTTP 503이 재현됐다. Cassandra 페이지 누락과 부분 GEO 유실 복구를 먼저 보장하고 조회량·동시성·검색 예산을 조정한다. 0/20/200/201 후보, 빈/부분 유실 GEO, Cassandra 다중 페이지를 검증한다. 위치 인가까지 전역 timeout을 늘리거나 후보를 잘라 누락을 숨기는 변경으로 종료하지 않는다. 인증 작업과 독립적으로 착수 가능하다. |
| 5 | **WGO-ARCH-05** | 12의 소유권·상태 매핑 확정 뒤 Moderation 판단을 Post 원본에 적용한다. 중복·역순 결정, 원본 버전 확인, 원자적 변경과 Outbox, Map/Notification 확정 사실 반영까지 검증한다. 자동 제재·자동 종료를 제공하려면 필수다. |
| 6 | **WGO-ARCH-06** | 현재 Post 삭제·만료·댓글 삭제의 WS 전파는 05 완료 전에도 구현할 수 있다. Moderation 적용 결과까지 포함하는 전체 흐름은 05 이후 검증한다. 다중 WS 인스턴스, 오래된 생성 이벤트, Room 종료와 재연결 복구를 포함한다. |
| 독립 소규모 수정 | **QA-01 GET 503 과도한 retry + timeout 502 오매핑** | 장애 upstream에 설정 1회 대신 11회 호출되는 증폭을 먼저 막고 timeout을 504로 매핑한다. retry=0/1의 실제 호출 수와 실제 지연 서버 응답을 검사한다. Gateway를 수정하는 1차 작업에 함께 앞당길 수 있다. |
| 외부 WS 공개 전 | **WGO-ARCH-09** | 대기 메시지와 송신 버퍼가 무제한으로 쌓이는 경로를 제한한다. 적은 연결에서도 과도한 발신자·느린 수신자가 영향을 줄 수 있어 일반적인 대규모 최적화보다 앞선다. 정상 연결을 유지하면서 해당 연결만 제한되는지 검증한다. |
| 통합 검증 전에 병행 | **WGO-ARCH-14** | 요청→Post→Outbox→소비자를 같은 문맥으로 연결해 04/05/06 수정의 장애 추적을 가능하게 한다. 원본 오류 envelope와 mutationId도 QA에서 보존한다. 관측성 추가 자체를 원인 해결로 간주하지 않는다. |
| 공개 API 마무리 | **QA-10 잘못된 Push 구독 입력 500** | 공백 token·잘못된 platform을 400으로 반환한다. 저장 전 검증이므로 인증 우회·검색 누락보다 뒤지만, 공개 API 계약 확정 전 수정한다. 정상 구독과 잘못된 입력에서 저장 부작용이 없는지 회귀 검증한다. |

#### 3차: 데이터·트래픽 확대 전 — 처리량과 저장 범위 제한

| 기본 순서 | 대상 | 우선순위 근거 |
| --- | --- | --- |
| 7 | **WGO-ARCH-07** | 완료 이력까지 매번 읽는 Notification 재시도 스캔을 상태·다음 시도 시각 기준의 제한된 배치로 바꾼다. 누적 이력과 replica 수에 따른 비용을 확인하고 lease·멱등성을 유지한다. |
| 8 | **WGO-ARCH-08** | 12/05에서 확정한 수명주기 소유권을 기준으로 Moderation 전체 평가와 단일 JSON 증가를 개선한다. 정책을 확정하기 전에 대규모 저장 구조 변경을 시작하면 재작업 위험이 크다. |
| 9 | **WGO-ARCH-10** | 큰 게시물의 투표 후보 선정을 제한 조회로 개선한다. 댓글 수에 따른 트랜잭션 시간과 조회량을 측정하고 기존 후보 선정의 동시성 보장을 유지한다. |

07/08/10의 순서는 예상 알림 이력·활성 게시물·댓글 규모에 따라 바꿀 수 있다. 이번 로컬 QA에는 운영 SLO와 포화 임계점 증거가 없으므로 측정 없이 긴급 장애로 승격하지 않는다. 반대로 이미 해당 규모로 공개할 계획이면 출시 전 단계로 앞당긴다.

#### 4차: 후속 개선 — 구조와 자원 분리

- **WGO-ARCH-13:** 04/07/10 등의 실제 수정에서 검증하기 어려운 정책만 작은 범위로 분리한다. 전체 서비스 계층 재작성은 배포의 선행 조건이 아니다.
- **WGO-ARCH-15:** 온라인 검색과 인덱싱이 경합하는 부하를 측정한 뒤 Worker 분리 여부를 결정한다. QA-09의 확정된 Map deadline 실패를 E5 병목으로 바꾸어 설명하지 않는다.

### CD 진행 및 추가 확인의 경계

- **비공개 staging CD 구축:** 11의 최소 검사와 실제 컨테이너 기동 검증, 12의 배포에 필요한 저장소 기준을 갖추면서 진행할 수 있다. 모든 성능 개선이 끝날 때까지 파이프라인 작성을 기다릴 필요는 없다.
- **운영 트래픽 공개:** 01/02의 우회를 막고 03의 운영 토큰 호환성을 검증해야 한다. Gateway 크기 제한·재시도·timeout과 WS 자원 상한을 검증하고, 공개할 검색·자동 종료·실시간 기능에 해당하는 04/05/06을 완료한다. 미완성 기능을 제외하려면 UI에서만 숨기지 말고 서버 경로·worker에서도 비활성화해야 한다.
- **QA의 BLOCKED 연결:** [연결 표](../../qa/artifacts/20261023-local-6975fb3/connection-matrix.md)의 Post/WS→User 제품 client, 공개 주변 검색 조합, 사용자별 Notification WS, 일부 알림·투표 이벤트는 확정 결함 7건과 별도다. 출시 범위에 포함하면 계약·구현·종단 간 검증을 출시 조건으로 추가하고, 미포함이면 미제공 기능으로 명시한다. 모든 BLOCKED를 결함이나 이미 해결된 기능으로 합산하지 않는다.
- **미확정 WS 오류:** [QA-13 관측](../../qa/artifacts/20261023-local-6975fb3/QA-13/findings.md)의 9,000건 중 `command.error` 1건은 원본 오류가 없어 timeout으로 확정하지 않는다. 같은 mutationId 재시도에서 중복 저장이 없었던 증거는 유지하며, 14와 함께 trace·오류를 보강해 별도 프로세스 환경에서 재측정한다.
- **CI 간헐 실패 조사:** 동일 커밋 `4104986`의 User 동시성 테스트가 [dev 실행](https://github.com/WGO-What-s-Going-On/Backend/actions/runs/39911143559)에서는 201 대신 401로 실패하고 [후속 브랜치 실행](https://github.com/WGO-What-s-Going-On/Backend/actions/runs/39911851271)에서는 성공했다. 11에서 원인을 재현·분리한다. QA 확정 결함 7건에 추가 합산하거나 재실행 성공만으로 해결 처리하지 않는다.

이번 갱신은 기존 QA·아키텍처 증거와 CI 로그를 바탕으로 실행 순서를 정한 것이다. 제품 수정·새 통합 테스트·ECS 검증은 수행하지 않았으며 GitHub Issue 생성·라벨·담당자 변경도 포함하지 않는다.

## 검토 상태와 검증 기록

아래 결과는 2026-10-23 아키텍처 검토 시점의 기록이다. 이 문서 작성이나 검사 통과가 위 이슈 해결을 의미하지 않는다.

| 애플리케이션 | 타입 검사 | 빌드     | 실행한 기존 테스트 통과 | 기본 실행에서 건너뜀           |
| ------------ | --------- | -------- | ----------------------- | ------------------------------ |
| User         | 통과      | 통과     | 24                      | 선택한 4개 파일만 실행         |
| Post         | 통과      | 통과     | 69                      | 48                             |
| Map          | 통과      | 통과     | 27                      | 13                             |
| Notification | 통과      | 통과     | 51                      | 별도 통합 설정 미실행          |
| Moderation   | 통과      | 통과     | 42                      | 별도 통합·외부 API 설정 미실행 |
| HTTP Gateway | 통과      | 통과     | 21                      | 2                              |
| WS Gateway   | 통과      | 통과     | 14                      | 2                              |
| 합계         | 7개 통과  | 7개 통과 | 248                     | 기본 실행에서 65개 skip        |

- 실행 환경: Node.js 24.21.0. 각 앱에서 저장소의 `pnpm typecheck`, `pnpm build`, `pnpm test` 명령을 사용했다.
- User 선택 테스트: `refresh-token.test.ts`, `kakao-oauth.client.test.ts`, `service-auth.test.ts`, `openapi.test.ts`.
- 별도 격리 검증 5개: 운영 신원 헤더 전달, 사용자 토큰 검증 불일치, Map 후보별 조회량, Map 빈 검색 및 후속 페이지 무시, WS 사용자별 인가 부재. 모두 지적한 현재 동작을 재현했다.
- 격리 검증은 실제 Gateway·Controller와 필요한 어댑터 Mock을 사용했다. 실제 계정 변경 및 실제 Cassandra 부하 측정은 수행하지 않았다.
- 재현 코드는 검토 환경의 임시 경로에만 작성했으며 저장소 회귀 테스트에는 포함되지 않았다. 수정 시 각 항목의 완료 조건에 맞는 영구 회귀 테스트를 추가해야 한다.
- 실제 DB·브로커 통합 테스트, 외부 Push·AI 호출, ECS 배포, 부하 테스트는 이번 검토에서 실행하지 않았다. 처리량·P95 지연·최대 동시접속 수는 미확정이다.
- 현재 저장소에는 별도 lint 스크립트가 없으므로 lint 통과로 기록하지 않는다. 아키텍처 검토 중 추적 파일 변경은 없었다.

검토 결론은 **인증·인가 및 서비스 연동 차단 이슈가 남아 있음**이다. 운영 준비 여부는 각 기능의 완료 조건과 실제 환경 검증으로 별도 판단한다.
