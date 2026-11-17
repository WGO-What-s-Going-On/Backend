# Notification 전용 주변 사용자 조회 (신규 계약)

기존 `map-authorization.proto` 및 HTTP 계약은 변경하지 않는다.
별도 package `wgo.map.notifications.v1`, service `MapNotificationRecipients`를 추가한다.
Map의 `MAP_NEARBY_NOTIFICATIONS_ENABLED=true`일 때만 등록한다. 기본 OFF다.
신규 키 설정 검증 실패는 로그를 남기고 신규 service 등록만 생략한다. 기존 Map 시작을 막지 않는다.
이 경우 새 RPC의 UNIMPLEMENTED도 Notification에서 성공으로 바꾸지 않고 재시도한다.

## 인증

기존 Post 인증 설정과 분리된 `MAP_NOTIFICATION_TRUSTED_JWKS`를 사용한다.
키는 EC/P-256/ES256 public JWK이며 `iss=wgo-notification-service`와 `kid`를 포함한다.
Notification은 기존 `NOTIFICATION_SERVICE_PRIVATE_JWK`로 다음 서비스 JWT를 발급한다.

- header: alg=ES256, typ=wgo-service+jwt, kid.
- claims: iss=wgo-notification-service, sub=notification-service, aud=wgo-map-service,
  iat, exp. 유효기간 최대 60초, 실제 client는 30초.
- gRPC metadata `authorization: Bearer <JWT>`. HS256, User JWT, Post JWT는 허용하지 않는다.

## 인덱스 준비

Notification의 기존 PostgreSQL 구독이 **동의 원본**이다. 활성 구독의 ID/revision/기존 만료 시각만 Map에 전달한다.
사용자 원본 좌표를 Notification에서 전달하거나 알림 payload로 노출하지 않는다.
Map은 기존 위치 저장소의 최신 위치와 이동 상태를 읽고 별도 H3 resolution 8 인덱스를 만든다.

1. `BeginSnapshot(expected_count)` → snapshot_id. 최대 10,000명, 0명도 명시적으로 허용한다.
2. `AddRecipients(snapshot_id, recipients[])`: 한 번에 1..50명. user_id/revision/expires_at_ms.
   Map 원본 조회는 최대 5개 동시 실행이다. 알림 동의 유효기간은 기존 최대 15분을 넘길 수 없다.
3. `PublishSnapshot(snapshot_id)`: 기대 인원만큼 준비된 snapshot만 active로 공개한다.
   준비 실패·부분 snapshot은 공개하지 않는다. 준비 시작부터 30초 TTL이며 공개/갱신으로 연장하지 않는다.

저장 키는 모두 새 `map:notification-recipients:v1:` namespace다.
`active`, `snapshot:<UUID>` hash, `snapshot:<UUID>:cell:<H3>` set만 사용한다.
기존 Cassandra 테이블·컬럼·TTL, 기존 Redis key는 변경하거나 삭제하지 않는다.
snapshot에는 동의 metadata와 H3 cell만 있고 정밀 좌표는 저장하지 않는다.
cell membership와 manifest count는 Lua로 함께 변경하고 snapshot의 남은 TTL을 따른다.
이 인덱스는 알림 후보 발견을 위한 파생 데이터이며 권한/거리 판정의 원본이 아니다.

## 조회와 정책

`FindNearbyUsers(latitude, longitude, participation_radius_m, author_id, limit, after_user_id)`.
반경은 실제 PostCreated의 참가 반경 1..10,000m를 전달한다. limit은 1..50이다.
결과는 `{users:[{user_id,revision}],next_after_user_id}`이며 좌표·거리·개인정보는 반환하지 않는다.

- 두 H3 ring의 후보를 ID 문자열의 C 정렬 순서로 탐색한다. 한 페이지에서 **후보 최대 50명**만 원본 재검사한다.
  실제 반경은 `min(150m, participation_radius_m)`이며 기존 `decide`/`distanceM`를 그대로 호출한다.
- 원본 5분 최신성, 미래 위치 최대 5초 허용을 유지하고 USER_MOVING/MOVEMENT_UNCONFIRMED를 제외한다.
  만료한 동의에 대해서는 위치를 읽지 않는다. 작성자는 제외한다.
- 대상자가 없는 중간 페이지도 next_after_user_id가 있으면 계속 처리한다. 마지막 페이지는 빈 cursor다.
- Notification은 반환 revision과 현재 구독을 transaction 안에서 대조한다. 동의 철회·갱신·만료,
  사용자/게시글 알림 설정을 다시 적용하고 User의 권위 있는 양방향 차단/활성 상태 API를 호출한다.
  발송 시 기존 delivery 경로의 추가 재검사도 유지한다.

인증 실패 UNAUTHENTICATED, 입력 오류 INVALID_ARGUMENT,
저장소/인덱스 미준비·유실·손상·조회 중 snapshot 교체는 UNAVAILABLE다.
마지막 경우를 빈 목록 성공으로 바꾸지 않는다. client deadline은 조회 2초, 준비 RPC 각각 5초다.

## 갱신·복구·한계

- 기존 위치 저장 완료 후 observer에 ID만 예약한다. 동기 I/O/추가 await는 없으며 observer 예외는
  기존 API 결과에 전파하지 않는다. 별도 Redis 연결과 100ms worker가 등록된 사용자만 갱신한다.
  새 조회 RPC는 같은 프로세스의 예약된 갱신이 끝난 뒤 후보를 탐색한다. 예약이 없으면 background Redis I/O도 없다.
- Notification worker는 약 10초마다 기존 활성 동의 목록으로 완전한 새 snapshot을 만든다.
  재시작 시에는 캐시를 비우고 다시 준비한다. 원본 Map 캐시가 없어도 기존 Cassandra fallback을 사용한다.
- source/Redis 실패나 dirty queue 1,000명 초과는 active를 무효화한다.
  root/snapshot 유실, 누락된 cell/user record, cell count 불일치를 정상 empty와 구분한다.
  Notification은 실패 시 동기화 캐시를 무효화하고 같은 durable job/cursor를 재시도한다.
- 실시간 인덱스는 비동기 파생 데이터다. 저장과 index 갱신은 분산 transaction이 아니며,
  쓰기 직후/재구축과 겹친 이동은 다음 갱신 또는 완전한 재구축에 반영된다.
  원본 재검사로 오래된 후보가 잘못 수신되는 것은 방지한다. 위치 변경과 fanout의 선형화는 보장하지 않는다.
- 동의 10,000명 초과, 동기화 20초 초과는 조용히 잘라내지 않고 실패/재시도한다.
  로컬 검증은 115명 pagination과 혼잡 cell의 제한된 처리까지다. 운영 규모 부하 검증은 별도다.
- 기존 알림 작업의 위치 사용 기한 15분은 연장하지 않는다. 기한 내 복구되지 않은 작업은 기존 cleanup 정책을
  따르되 `NEARBY_LOCATION_WINDOW_EXPIRED` 로그로 드러낸다. 유효 기간 밖의 위치로 재발송하지 않는다.

운영은 플래그 OFF를 유지한다. 활성화 전 별도 부하 검증·설정 승인과 FE 명시적 동의 연동이 필요하다.
