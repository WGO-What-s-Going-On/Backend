# 프론트엔드 연동 계약

프로필 이미지 업로드·검증·Signed GET·재시도는 [User 프로필 이미지 계약](../../services/user-service/PROFILE_IMAGE_GCS_IMPLEMENTATION_REPORT.md#4-api프론트엔드-연동-계약)을 따른다.
`PATCH /api/v1/users/me`의 `profileImageKey`는 이제 제거용 `null`만 받으며 문자열 설정은 400이다.

대상 브랜치: `dev`. 이 문서는 구현 계약이며 실제 운영 배포·카카오 콘솔 등록 완료를 뜻하지 않는다.
화면 기준: Frontend `67186831ee5a11854c7b48166bbb3f9a5a563ce9`.

## 인증과 배포 순서

모든 아래 경로의 기준은 `/api/v1`이다. 로그인·refresh·약관·닉네임 중복 확인 외에는
`Authorization: Bearer <User accessToken>`을 보낸다. `X-User-Id`를 프론트에서 만들지 않는다.
Gateway가 사용자 JWT를 검증하고 대상 서비스 audience의 30초 ES256 서비스 JWT로 교체한다.
Post·Map·Notification·Moderation은 서비스 서명과 JWT의 `userId`가 전달 헤더와 일치하는지 검증한다.
인증 우회로 503을 없애는 변경이 아니다. 서명이 없거나 사용자 ID가 변조되면 401이다.

1. User PostgreSQL의 `pnpm migration:run` 실행: nullable `users.real_name` 추가.
2. Gateway의 기존 `HTTP_GATEWAY_SERVICE_PRIVATE_JWK`에 대응하는 **공개키만** 각 서비스의
   `POST_HTTP_GATEWAY_TRUSTED_JWKS`, `MAP_HTTP_GATEWAY_TRUSTED_JWKS`,
   `NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS`, `MODERATION_HTTP_GATEWAY_TRUSTED_JWKS`에 주입.
   JWKS 항목에는 `iss=wgo-http-gateway`, `alg=ES256`, `kty=EC`, `crv=P-256`, `kid`, `x`, `y`가 필요하다.
   기존 `USER_HTTP_GATEWAY_TRUSTED_JWKS`와 동일한 공개키를 쓸 수 있다. `d`를 넣지 않는다.
3. Post의 `USER_GRPC_ADDRESS` 및 User의 기존 `USER_SERVICE_TRUSTED_JWKS`에 Post 서명키를 연결.
   작성자 닉네임은 User `BatchGetUserProfiles` RPC로 페이지당 최대 100명을 조회한다.
4. Map·User·Post·Notification·Moderation·WS의 신규 버전을 배포한 뒤 HTTP Gateway를 배포.
   Gateway부터 배포하면 구 서비스는 여전히 운영 요청을 거절한다.
5. MongoDB의 신규 활동 조회 인덱스를 `createIndexes()`로 준비한다. 이 변경은 기존 인덱스 삭제를 요구하지 않는다.
   대용량 운영 컬렉션에서는 먼저 인덱스 생성 시간을 확인한다.
6. Gateway Swagger 문서를 다시 생성한다. Moderation도 `/docs/openapi.json`을 제공한다.
   공개 문서의 모든 보호 경로는 User Access Bearer 인증으로 표시한다.

`dev`의 배포 방식에 맞게 위 환경변수를 실제 task definition/secret 주입에 반영해야 한다.
이 PR은 배포나 Secret 값을 변경하지 않는다.

## 공개 게시글 조회와 필드

`GET /posts/nearby?latitude=37&longitude=127&radiusM=150&sort=distance&limit=20`

- 필수 좌표는 latitude -90~90, longitude -180~180. radiusM은 기존 Map 계약인 150/250/350, 기본 150.
- `sort=distance|latest`(기본 distance), `category`, `q`(제목·본문 부분 문자열, 최대 100자), `cursor` 선택.
- limit 1~100. 응답 `{posts: [...], nextCursor: string|null}`. 검색도 이 API의 `q`를 사용한다.
- 거리 및 최신 정렬은 postId로 동률을 해소한다. 커서는 좌표·반경·정렬·필터에 묶인다.
- Map 후보를 Post 원본의 ACTIVE·자동 만료·작성자 종료·좌표·카테고리로 다시 검증한다.
- 전체 정렬의 정확성을 위해 후보를 최대 1,000개/4초 범위에서 수집한다. 초과하면 부분 결과를 성공으로
  반환하지 않고 503이다. 다음 페이지 조회 중 새 글·종료·수정에 따른 현재 상태 변화는 반영된다.

상세 `GET /posts/{postId}`에 latitude/longitude를 **함께** 전달하면 `distanceM`을 계산한다.
좌표를 주지 않으면 상세 거리는 null이다. 주변 목록은 항상 원본 좌표로 계산한 미터 거리를 반환한다.

조회 응답의 추가 필드:

| 대상 | 필드 | 의미 |
| --- | --- | --- |
| 게시글 | anonymous | 기존 데이터 기본 false. 작성 요청에서 boolean 선택 가능 |
| 게시글 | authorNickname | 익명 또는 조회할 수 없는 프로필은 null |
| 게시글 | authorId | 익명 글을 다른 사용자가 조회하면 null. 작성자 본인에게만 ID 유지 |
| 게시글 | reactionCounts | CURIOUS/STILL_HAPPENING/HELPFUL/ENDED 각 0 이상의 개수 |
| 게시글 | myReaction | 본인 활성 반응 종류 또는 null. 기존 LIKE 데이터는 읽기 호환 유지 |
| 게시글 | closedAt | 작성자가 닫은 시각 또는 null. 자동 만료·삭제와 별개의 상태 |
| 댓글 | authorNickname, myReaction | 작성자 이름 및 본인 활성 댓글 반응 또는 null |
| 댓글 | parentCommentId | 같은 게시글의 ACTIVE 최상위 댓글 ID. 답글은 한 단계만 지원 |
| 댓글 | verified | 작성 당시 Map 인가로 150m 이내임을 확인. 과거 댓글은 false |
| 내 프로필 | realName | PATCH /users/me로 null 또는 1~100자. 본인 조회에만 포함 |

실명은 공개 프로필 RPC와 사용자 이벤트에 포함하지 않으며 탈퇴 확정 때 삭제한다.
반응 변경은 기존 규약대로 기존 종류를 DELETE한 다음 새 종류를 POST한다.
댓글 답글 생성은 부모 삭제와 트랜잭션 충돌을 일으키는 쓰기를 포함한다.

`GET /posts/categories`:

| 코드 | 화면 |
| --- | --- |
| EMERGENCY | 긴급 사고 |
| HELP | 도움 요청 |
| NEWS | 동네 소식 |
| ETC | 일상 불편 |

기존 INCIDENT/CROWD 등 대문자 카테고리 기록은 하위 호환을 위해 삭제·변환하지 않는다.
신규 프론트 작성에는 위 네 코드를 사용한다.

## 신규 쓰기 및 사용자 기능

| 요청 | body / query | 응답·정책 |
| --- | --- | --- |
| PATCH /posts/{postId} | title 및/또는 content | 작성자만, 활성·미종료 글만. 204. 위치·카테고리는 수정하지 않음 |
| PUT /posts/{postId}/closed | `{closed:true|false}` | 작성자만, 멱등 204. 자동 만료·삭제·제재된 글의 재개는 거절 |
| POST /moderation/reports | `{targetType:"POST"|"COMMENT",postId,commentId?,reason,description?}` | 201. enum 사유, description 최대 2,000자. 전용 대상 검증 키/URL 미설정·조회 장애는503 |
| DELETE /moderation/reports/{reportId} | 없음 | 본인 PENDING만 취소, 200. 중복 취소는 최초 결과 |
| POST /users/me/blocks | `{blockedUserId:"123"}` | 자기 차단 금지, ACTIVE/SUSPENDED 대상만, 멱등 204 |
| DELETE /users/me/blocks/{blockedUserId} | 없음 | 멱등 204 |
| PUT /users/me/blocks | `{userId:"123"}` | 자기 차단 금지, 존재 사용자만, 멱등 204 |
| DELETE /users/me/blocks | `{userId:"123"}` | 멱등 204 |
| GET /users/me/blocks | cursor·limit 선택 | `{items:[{userId,nickname,profileImageKey,blockedAt,createdAt}],nextCursor}`. 기본 30/최대 100명. 기존 숫자 cursor도 유지 |

차단은 User가 관계를 소유한다. 프론트는 차단 목록으로 표시할 작성자 콘텐츠를 숨긴다.
이 API는 차단 대상의 서비스 전체 접근권을 박탈하는 제재 API가 아니다.
신고 원본·이벤트 journal은 Redis `moderation:reports:v1:records` HASH, 복구 대상은 `moderation:reports:v1:pending` SET에 보관한다. 기존 `moderation:report:<hash>` 데이터는 보존하며 자동 이관하지 않는다. REPORT_CREATED/REPORT_WITHDRAWN은 기존 moderation:report-events로 발행한다. 자동으로 삭제·제재하지 않는다.
신규 신고는 Moderation 전용 ES256으로 Post의 읽기 전용 대상 검증을 통과해야 한다. [대상 검증 계약](../../services/moderation-service/contracts/reports.md)의 별도 키·URL이 미설정이면503이다. 접수·취소 알림은 본인 알림함에만 기록하고 검토 완료를 뜻하지 않는다. REVIEWED 관리자 명령/완료 생산자는 아직 없으므로 처리 결과 알림을 만들지 않는다. 실제 운영 키·GCP 연동 검증과 로컬 테스트는 구분한다.
운영 Redis 영속성·백업·용량·보존 정책은 원본 데이터까지 포함해야 한다. 차단은 기존 User PostgreSQL 관계와 Outbox를 함께 커밋한다.

작성자 종료 시 투표 결과를 확정하며 재개해도 이미 확정된 투표를 재시작하지 않는다.
본문 수정·종료·재개는 MongoDB와 Outbox를 같은 트랜잭션으로 기록한다.
새 `PostUpdated` v1 이벤트는 `{post:{postId,authorId,category,closedAt},postVersion}`을 담는다.
Semantic Worker는 최신 원본을 재조회하며 종료 글은 검색 인덱스에서 제거한다.
WS는 `post.updated`(postVersion, closedAt)로 전달한다. 닫힌 Room은 정리하고 재개 후에는 다시 구독한다.
Map은 공간 후보를 유지하므로 최종 공개 여부는 항상 Post에서 확인한다.

## 알림

`GET /notifications?limit=20&cursor=...` → `{items: Notification[], nextCursor?:string}`.
Notification에는 notificationId, userId, type, title, body, actorId, targetType, targetId,
actionPath, count, isRead, createdAt, expiresAt 및 선택적 commentId가 있다.
Swagger에 목록 응답 스키마가 포함된다.

- `GET/PATCH /notifications/settings`: nearby, replies, reactions, lifecycle boolean. 기본 모두 true.
  PATCH는 일부 필드만 보내도 되며 동시 수정은 서로 다른 설정을 덮어쓰지 않는다.
- `GET/PUT /notifications/boards/{postId}`: `{postId,enabled}` / PUT body `{enabled:boolean}`.
- 설정은 Notification PostgreSQL의 `notification_preferences`·`notification_board_preferences` 테이블에 보관한다.
- 구현된 댓글·게시글 반응 이벤트는 설정이 꺼져 있으면 신규 Inbox·Push를 생성하지 않는다.
  대기 중 Push도 전달 직전에 설정을 확인한다. 이미 만들어진 Inbox 기록은 설정 변경으로 삭제하지 않는다.
  nearby/lifecycle 값 저장은 지원하되 기존에 없던 주변 새 글·종료 알림 fan-out을 새로 생성하지는 않는다.
- `PATCH /notifications/read-all?cursor=...` → `{processed,nextCursor}`. 요청당 최대 100개를 처리한다.
  프론트는 nextCursor가 null일 때까지 반복한다. 전체 읽음은 스냅샷 트랜잭션이 아니며 새 도착 알림은 별도다.
- `DELETE /notifications/{notificationId}`: 소유 사용자 범위에서 멱등 204. tombstone을 보관하고
  목록·미읽음 집계에서 제외한다. 삭제한 ID를 일반 increment가 되살리지 않는다.

## 활동·칭호·행정동 랭킹

- `GET /posts/me/activity?cursor=...` → `{items,nextCursor}`. 20개씩 최신순.
  kind=POST/COMMENT/REACTION/COMMENT_REACTION/VOTE, postId, commentId, createdAt, postStatus, closedAt, coverFocus.
  coverFocus는 부모 게시글의 사진 초점이며 미지정·기존 문서는 null이다.
  postStatus는 부모 게시물에 저장된 ACTIVE 또는 EXPIRED다. 만료 게시물의 활동은 포함하고,
  DELETED이거나 존재하지 않는 부모 게시물의 활동은 모든 kind에서 제외한다.
  closedAt은 부모 게시물의 작성자 수동 종료 시각이다. null이어도 EXPIRED일 수 있으며,
  수동 종료된 게시물은 postStatus=ACTIVE와 closedAt을 함께 반환한다.
  투표의 createdAt은 선택 갱신 시각이다. 다음 페이지는 응답의 nextCursor를 그대로 전달한다.
  부모 상태 필터를 페이지 크기 제한 전에 적용한다. ACTIVE 및 EXPIRED 게시물의 상세·댓글은 조회할 수 있다. expiresAt이 지났어도 읽기를 차단하지 않는다.
  종료·만료만으로 게시물·댓글 첨부를 삭제하지 않는다. 이미 정리된 첨부는 `media` 배열에서 제외하며 상세·댓글 페이지 전체를 404로 만들지 않는다. 삭제된 게시물·댓글의 첨부 정리는 유지한다.
  EXPIRED 또는 종료·만료된 게시물의 댓글·게시물 감정표현·댓글 감정표현 작성은 403이며, DELETED의 상세·댓글 조회는 404다.
  현재 남아 있는 작성·댓글·반응·투표 관계를 집계하며 취소된 관계는 제외한다.
- `GET /posts/me/level` → participation, agreeReceived, picks, score, level(1~4), title.
- 프론트 `features/level/levels.ts` 기준: 참여 10회 → 받은 AGREE 10개 → 대표 의견 50점.
  모든 선행 조건을 충족해야 다음 칭호를 얻는다. 대표 의견 1회=10점. 삭제된 글·댓글의 대표 의견은 제외.
- `GET /posts/me/region?latitude=&longitude=` → `{code,name}`.
  Map의 `ResolveRegion` RPC가 [Kakao 좌표→행정구역 API](https://developers.kakao.com/docs/ko/local/dev-guide#coord-to-district)의
  **H(행정동)** 코드를 사용한다. 법정동 B로 대체하지 않는다. 상도1동·상도2동은 별개 코드다.
- `GET /posts/me/ranking?regionCode=<10자리 코드>` → regionCode, items(상위100), myRank|null, myScore.
  전역 칭호가 천리안인 사용자만 포함하며 해당 행정동 게시글에서 받은 대표 의견 점수 순이다.
  동점은 userId 오름차순으로 정한다. 한 사람이 여러 동에서 활동하면 각 동에 등장할 수 있다.
- 신규 글은 위치 인가 뒤 Map `ResolveRegion`으로 행정동을 항상 조회·저장한다.
  Map에 `KAKAO_LOCAL_REST_API_KEY`가 필요하며, 조회 실패나 잘못된 응답은 게시물·Outbox 저장 없이 503으로 반환한다.
  `POST_REGION_ENABLED`는 더 이상 사용하지 않는다. 미설정·false여도 생성과 지역 랭킹을 비활성화하지 않는다.
- 기존 글은 Post에서 `pnpm build` 후 `pnpm region:backfill 100`을 반복한다.
  한번에 최대 1,000개, 이미 기록된 지역은 덮어쓰지 않는다. 운영 데이터 변경은 별도 실행 단계다.
- 지역 후보 1,000명 및 각 DB 집계 2초 제한. 초과 시 잘못된 순위를 반환하지 않고 503.
  이 버전은 물리적인 거주지 인증 또는 고정된 홈 지역 정책을 도입하지 않는다.

## 카카오·약관·브라우저 연결의 외부 설정

- User `KAKAO_REST_API_KEY`와 redirect URI를 실제 값으로 주입한다.
  웹 redirect는 `http://localhost:5173/auth/kakao/callback`. 카카오 콘솔에도 정확히 같은 URI를 등록한다.
  Secret 값이나 콘솔 등록을 이 PR에서 변경하지 않았다.
- 로그인/refresh는 응답 토큰과 함께 `wgo_access_token` HttpOnly 쿠키를 발급하고 logout은 지운다.
  프론트 fetch는 `credentials:'include'`. 운영 쿠키는 Secure/SameSite=None.
  HTTP·WS가 다른 서브도메인이면 `AUTH_COOKIE_DOMAIN`을 공통 부모 도메인으로 설정한다.
  WS의 `JWT_COOKIE_NAME=wgo_access_token`과 허용 Origin 목록을 맞춘다. HTTP API는 계속 Bearer를 사용한다.
  브라우저의 타사 쿠키 차단 환경에서는 같은 사이트 도메인으로 HTTP/WS를 제공해야 한다.
- 필수 약관은 기존 `pnpm seed:terms` 사용. code는 SERVICE, PRIVACY_COLLECTION_USE, LOCATION.
  `TERMS_SERVICE_DOCUMENT_URL`, `TERMS_PRIVACY_DOCUMENT_URL`, `TERMS_LOCATION_DOCUMENT_URL`에
  User Service `.env.example`의 공개 약관 URL을 넣는다.
  `https://wgo-what-s-going-on.github.io/Frontend/terms/` 아래 `service.html`, `privacy.html`, `location.html`이 각각 대응한다.
  게시된 문서의 버전은 `1.0`, 시행일은 `2026-09-01`이다.
  초기화 명령과 재실행 규칙은 [User Service 약관 초기 데이터](../../services/user-service/README.md#terms)를 따른다.
  설정 파일의 URL만 갱신해도 DB는 바뀌지 않는다. 대상 환경에서 초기화 명령을 실행한 뒤 세 약관 조회를 확인한다.
- iOS 앱 복귀는 요청대로 웹 연동 이후 항목이다. 앱 Bundle ID·URL scheme/Universal Link와
  카카오 Native SDK 또는 별도 허용 redirect 계약 확정이 필요하다. 웹 localhost URI를 앱에 사용하지 않는다.

## 검증 경계

MongoDB 통합 테스트는 프론트 응답·답글·반응·종료/재개·권한·행정동 점수 분리를 검증한다.
닉네임 RPC와 Map 후보는 테스트 대역이며, Map 행정동 응답과 좌표 순서는 HTTP 대역으로 별도 검증한다.
Notification은 실제 로컬 PostgreSQL/Redis에서 설정·삭제·전체 읽음을 검증한다.
실제 카카오 OAuth/행정구역, 운영 MongoDB replica set 호환성·성능, 실제 FCM 전송은 로컬 테스트 통과로 대체하지 않는다.
# Notification 위치 구독과 알림 설정 확장

기존 `/api/v1/notifications` 목록·읽음·삭제·FCM 토큰·게시글 mute를 유지한다. settings PATCH는 기존 네 boolean에 rewards/votes/moderation을 추가한다. 각 false는 해당 종류의 **새 알림함과 Push 모두** 억제한다. 기존 알림 이력은 유지하며 Push 직전에도 설정을 재검증한다.

`GET|PUT|DELETE /api/v1/notifications/nearby-subscription`은 기존 Access JWT→HTTP Gateway ES256 인증을 사용하며 서명된 본인만 접근한다. PUT `{enabled:true,locationConsent:true,latitude,longitude,capturedAt:"UTC ISO",expiresInSeconds?:60..900}`은 별도 주변 알림 opt-in과 위치 이용 동의다. 사용자 버튼/브라우저 위치 권한과 위치 이용 목적 동의 UI가 필요하며 기존 약관·게시글 참여·거주 지역으로 대신하지 않는다. 위치는 최대15분, 갱신에는 새 측정값이 필요하다. enabled=false만 보내거나 DELETE(204)하면 철회와 대기 Push 취소다. GET/PUT 응답은 `{featureEnabled,enabled,locationConsent,expiresAt,radiusM:150}`이며 좌표를 반환하지 않는다.

NEARBY_NOTIFICATIONS_ENABLED 기본false이며 OFF에서 새 위치 저장 요청은503이다. User 차단 조회 전용 키·URL과 프런트 동의 UI를 배포 검증한 후 true로 전환한다. 반경150m 포함, 작성자 제외, 양방향 차단/종류 설정/게시글 mute 적용, 사용자당 기본10분에 최대1회 예약한다. 위치 철회·갱신·만료 및 게시글 종료·삭제는 이전 미전송 작업을 취소한다. 다수 수신자는 영속 cursor/lease와 최대50명/페이지, 최대5개 권위 조회 동시 실행으로 처리한다.

FCM data.notificationId로 중복 표시를 막고 알림함을 원본으로 동기화한다. /posts/{id}와 commentId는 실제 원본 대상이 있는 경우만 사용한다. 칭호·신고·삭제 안내는 /notifications이며 payload.metadata에는 검증된 칭호/지역/레벨 등만 있다. regionName=null을 행정동 이름으로 추정하지 않는다. WS Notification 전용 인증 채널은 현재 없으며 REST/FCM으로 연결한다. 토큰 등록 성공과 실제 PWA 수신 성공은 별도 검증한다.

게시글 생성은 `coverFocus?: { x: number; y: number }`를 받는다. 가로·세로 0~100 정수이며 mediaIds가 있을 때만 지정한다. 생성·상세·주변 목록은 coverFocus 또는 null을 반환한다. 자세한 검증과 저장 규칙은 [미디어 계약](../../services/post-service/contracts/media.md)을 따른다.


## 쿠키 제한 환경의 WebSocket 연결

1. `POST /api/v1/realtime/tickets`에 `Authorization: Bearer <accessToken>`을 보낸다. body는 필요 없다.
2. `201 { ticket, expiresAt }`를 받고 `wss://<ws-host>/ws/v1?ticket=<encodeURIComponent(ticket)>`로 즉시 연결한다. 쿠키는 필요 없다.
3. 티켓은 최대 45초·한 번의 연결 시도에만 사용한다. 재연결은 새 티켓을 발급한다. 만료된 Access JWT는 먼저 refresh한다.
4. 연결 후 기존 board.join·댓글 프로토콜을 사용한다. 티켓 발급은 Room 참여 권한을 부여하지 않는다.

발급 응답은 no-store이며 로그·분석·영구 저장소에 남기지 않는다. WS에서 잘못된/만료/재사용 티켓은 401, Redis 확인 불가는 503, 금지 Origin은 403이다. 기존 Bearer·쿠키 접속도 유지한다. [WS 상세 계약](../../gateways/ws-gateway/README.md#일회용-websocket-티켓)을 따른다. 서버 배포·허용 Origin·프록시 로그 설정과 실제 Safari/iOS 연결은 후속 검증 대상이다.
