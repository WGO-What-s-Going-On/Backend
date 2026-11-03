# 서비스 구조화 로그

모든 상시 실행 서비스는 JSON 로그를 stdout에 출력한다. GKE의 기존 수집 경로를 그대로 사용한다. `severity`는 Cloud Logging의 로그 수준으로 인식되며, `message`는 목록에 표시할 짧은 설명이다.

## 공통 필드

| 필드 | 의미 |
| --- | --- |
| `service` | 로그를 출력한 서비스 |
| `domain` | vote, post, auth 등 처리 영역 |
| `event` | 검색 가능한 고정 작업 이름 |
| `outcome` | success, failure, skipped |
| `error.code`, `error.message`, `error.type` | 실패 분류, 안전한 설명, 예외 종류 |
| `reasonCode` | 중복·비활성 등 건너뛴 이유 |
| `requestId`, `correlationId` | 요청 및 후속 작업 연결 식별자 |
| `eventId`, `streamId`, `consumerGroup` | 비동기 메시지와 처리자 식별자 |
| `postId`, `commentId` | 관련 게시글과 후보 댓글 식별자 |
| `durationMs`, `statusCode`, `grpcStatus` | 처리 시간과 프로토콜 결과 |

작업에 해당하는 필드만 출력한다. 성공에는 오류 객체가 없고, 실패에는 오류 코드가 있다. 기존 응답과 이벤트 스키마는 유지한다. HTTP 응답 상태와 업무 상태 변경은 별개 로그이며, 저장 성공과 이벤트 전달 성공도 구분한다.

## 적용 범위

- HTTP Gateway: 요청 완료, 인증 실패, downstream 오류.
- WebSocket Gateway: 인증, 연결·종료, 메시지·참여 처리, 이벤트 전달.
- Post: 후보 선정·투표 열림·종료, 도메인 변경 커밋, 만료, Outbox, 미디어 정리, 검수 결과, 검색 인덱싱.
- User: HTTP/gRPC, Outbox, 탈퇴, 프로필 이미지 정리, 보상 이벤트, 랭킹·보상 정기 작업.
- Map: HTTP/gRPC, Stream 처리와 위치 인덱스 갱신.
- Notification: Stream 처리, 알림 생성·전달, 인근 알림, 데이터 정리.
- Moderation: Stream 처리, 콘텐츠 검수, 게시글 수명주기, 신고 Outbox.

운영 CLI의 명령 출력과 빌드 도구 출력은 이 규격의 대상이 아니다. 로그는 감사 원장이나 데이터베이스의 대체물이 아니다. 프로세스가 저장 직후 종료되거나 stdout 수집이 실패하면 성공 로그가 유실될 수 있다. 기존 이벤트에 연결 ID가 없는 경우 임의의 과거 요청과 연결하지 않는다.

## 레벨과 개인정보

작업 완료는 INFO, 실패는 ERROR(요청 거절은 WARNING도 사용), 빈 폴링·중복 처리는 DEBUG로 제한한다. `LOG_LEVEL`로 출력 수준을 조절한다. 정상 health check는 요청 완료 로그에서 제외한다.

토큰, 쿠키, 인증 헤더, 요청·응답 본문, 댓글 내용, 정밀 좌표, SQL 및 공급자 오류 원문은 출력하지 않는다. 공통 필드 허용 목록을 사용하며 오류 메시지는 호출부에서 제공한 안전한 설명이다. 원래 예외 이름과 스택 프레임으로 코드 위치를 추적한다. 따라서 공급자의 원문 메시지가 필요한 경우에는 별도 보안 검토가 필요하다.

## Logs Explorer 쿼리

공통 조건:

```text
resource.type="k8s_container"
resource.labels.namespace_name="wgo-demo"
```

전체 실패:

```text
resource.type="k8s_container"
resource.labels.namespace_name="wgo-demo"
jsonPayload.outcome="failure"
```

투표 생성과 후보 선정:

```text
resource.type="k8s_container"
resource.labels.namespace_name="wgo-demo"
jsonPayload.service="post-service"
jsonPayload.domain="vote"
jsonPayload.event=("vote.opened" OR "vote.candidate_selected" OR "vote.none" OR "vote.closed")
```

특정 게시글 흐름:

```text
resource.labels.namespace_name="wgo-demo"
jsonPayload.postId="post_조회할ID"
```

연결된 요청·이벤트:

```text
resource.labels.namespace_name="wgo-demo"
jsonPayload.correlationId="조회할ID"
```

오류 코드별 필터:

```text
resource.labels.namespace_name="wgo-demo"
jsonPayload.error.code="조회할오류코드"
```

시간 범위는 Logs Explorer에서 설정한다. 예전 Pod가 출력한 로그에는 새 필드가 없으므로 이 쿼리는 변경된 이미지 배포 이후 로그에 적용된다.

## 공통 코드 수정

서비스는 각각 독립된 Docker build context와 의존성을 사용한다. `shared/observability`를 원본으로 관리하고 `node scripts/sync-observability.mjs`로 각 서비스의 `src/observability`에 복제한다. 복제 파일을 직접 수정하지 않는다. CI의 `scripts/observability.test.mjs`가 원본과 복제본이 같은지 확인한다.

새 작업 로그는 `createLogger(service, domain)`을 사용한다. 실제 저장·커밋·ACK 완료 뒤에 해당 결과를 기록하고, 재시도 가능한 트랜잭션 콜백 안에서 성공을 출력하지 않는다. `failure`에 공급자 메시지를 넘기지 말고 고정 오류 코드와 안전한 설명을 넘긴다. 새로운 메타데이터가 필요하면 원본의 허용 목록과 개인정보 테스트를 함께 갱신한다.
