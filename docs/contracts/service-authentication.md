# 내부 서비스 인증 계약

이 문서는 WGO의 **Gateway→도메인 서비스 HTTP**와 **도메인 서비스→도메인
서비스 gRPC** 호출에 적용할 목표 인증 규약이다. Gateway는 도메인 서비스의
gRPC 클라이언트가 되지 않는다.
현재 구현 상태와 전환 순서는 아래에 따로 적었다. 사용자 Access JWT의 발급·검증
규약이나 Redis Streams 소비자 인증을 정의하지 않는다. RPC 메시지와 HTTP 본문은
각 서비스의 proto·OpenAPI 계약을 따른다.

## 1. 신뢰 경계

- 서비스 JWT는 **호출 애플리케이션의 신원**을 증명한다. 사용자 인증, 요청 본문
  검증, 데이터 소유 서비스의 최종 인가를 대신하지 않는다.
- 다른 서비스를 호출하는 애플리케이션은 서비스 인증용 **P-256 ES256 개인키를
  하나** 소유한다. 수신만 하는 서비스에는 서명 키가 필요 없다. 개인키는 해당
  애플리케이션의 런타임에만 비밀값으로 주입한다. 사용자 Access JWT 키와 서비스
  키는 분리한다.
- 수신 서비스는 자신에게 호출 권한이 있는 서비스의 **공개 JWK만** 배포 설정에서
  받는다. 키를 `(issuer, kid)`에 묶어 등록한다. 토큰에 적힌 URL이나 임의의
  `kid`를 따라 키를 가져오지 않는다. 공개키 배포는 요청 경로에서 다른 서비스나
  중앙 발급자를 조회하지 않는 방식으로 한다.
- 새 호출 관계에는 수신 서비스의 공개키 등록과 아래 권한표 변경이 함께 필요하다.
  공개키가 등록되어도 명시적으로 허용되지 않은 RPC·HTTP 경로는 호출할 수 없다.
- 내부 포트는 허용된 서비스만 접근할 수 있는 사설 네트워크에 둔다. 운영 전송
  구간에는 TLS를 적용한다. 서명 검증은 전송 암호화를 대신하지 않으며, 현재
  gRPC의 `createInsecure()` 사용만으로 TLS가 제공되지는 않는다.

## 2. 토큰 형식과 전달

호출자는 대상 서비스별로 토큰을 로컬에서 서명한다. 별도 토큰 발급 RPC는 없다.
서비스 ID는 `http-gateway`, `ws-gateway`, `user-service`, `post-service`,
`map-service`, `notification-service`, `moderation-service` 중 하나다.

| 위치             | 필수 값                | 규칙                                             |
| ---------------- | ---------------------- | ------------------------------------------------ |
| JWS header `alg` | `ES256`                | 다른 알고리즘 또는 `none` 거부                   |
| JWS header `typ` | `wgo-service+jwt`      | 사용자 Access JWT와 구별                         |
| JWS header `kid` | 발급 서비스의 키 ID    | 발급 서비스 안에서 유일하며 교체 시 변경         |
| `iss`            | `wgo-<호출 서비스 ID>` | 예: `wgo-post-service`                           |
| `sub`            | `<호출 서비스 ID>`     | `iss`의 서비스 ID와 일치                         |
| `aud`            | `wgo-<수신 서비스 ID>` | 한 대상 서비스로 제한                            |
| `iat`, `exp`     | 정수 Unix 초           | `exp > iat`, 수명 최대 60초; 기본 발급 수명 30초 |

gRPC는 **초기 metadata**의 `authorization: Bearer <JWT>`, 내부 HTTP는
`Authorization: Bearer <JWT>`로 전달한다. 인증값은 정확히 하나여야 한다.
토큰을 proto 메시지 필드, URL 또는 로그에 넣지 않는다. 호출자는 기존 계약의
deadline·timeout을 유지한다.

수신 서비스는 서명 검증 전에 `iss`를 **키 후보 선택에만** 사용하고, 등록된
`(iss, kid)` 공개키로 서명을 검증한 뒤 위의 모든 claim을 다시 확인한다.
`iat`는 현재 시각보다 5초를 넘게 미래이면 거부하며, `exp`가 지났으면 거부한다.
키의 `alg`도 ES256으로 고정한다. 이어서 **수신 서비스의 권한표**에서
`(호출 서비스 ID, RPC 또는 HTTP method·path)`를 확인한다. 등록되지 않은
서비스·키·대상·작업은 기본 거부한다. 사용자 Access JWT나 다른 서비스 대상
토큰을 내부 서비스 토큰으로 받아들이지 않는다.

인증 실패는 gRPC `UNAUTHENTICATED` / HTTP `401`, 인증된 호출자의 권한 부족은
gRPC `PERMISSION_DENIED` / HTTP `403`으로 구분한다. 키 설정이 없거나 조회할
수 없는 경우에도 요청을 허용하지 않는다. 클라이언트에 서명·키 정보를 노출하지
않는다.

서비스 JWT의 `sub`는 **사용자 ID가 아니다**. 사용자 대신 수행하는 요청은
Gateway가 사용자 Access JWT를 먼저 검증하고, 클라이언트가 보낸 `x-user-id`,
`x-session-id` 같은 내부 신원 헤더를 제거한 뒤 검증된 값으로 덮어쓴다.
수신 서비스는 Gateway의 서비스 인증과 해당 경로의 권한 확인을 마친 뒤에만
이 헤더를 사용한다. 서비스 간 proto의 `user_id`는 업무 입력이며 호출자 인증
수단이 아니다. 사용자 신원과 세션 값이 필요한 경로는 해당 HTTP·RPC 계약에도
전달 형식과 인가 책임을 명시한다.

HTTP Gateway의 공개 API 프록시에서는 클라이언트의 `Authorization`을 내부
서비스 인증에 재사용하지 않는다. Gateway 인증 연동 시 상류 요청의
`Authorization`은 서비스 JWT로 바꾸고, 필요한 사용자 문맥은 검증된 내부
헤더로 전달한다. 로그인·갱신처럼 사용자 Access JWT가 없는 공개 경로에서도
Gateway 자신의 서비스 JWT로 상류 호출을 인증한다. 이 변경은 현재 투명 프록시와
호환되지 않으므로 4절의 3단계에서 경로별로 구현한다.

## 3. 최소 권한표

아래 표의 **목표 허용 호출자 외에는 거부**한다. `현재`는 이 저장소에서 확인한
구현 상태이지 목표 규약을 이미 만족한다는 뜻이 아니다. 새 RPC나 내부 HTTP
경로는 배포 전에 이 표와 해당 proto·OpenAPI 계약을 함께 갱신한다.

### 도메인 서비스→도메인 서비스: gRPC

| 수신 서비스 | RPC                                       | 목표 허용 호출자 | 현재                                             |
| ----------- | ----------------------------------------- | ---------------- | ------------------------------------------------ |
| Map         | `MapAuthorization.CheckPostCreation`      | `post-service`   | Post→Map HS256 서비스 JWT 사용                   |
| Map         | `MapAuthorization.CheckPostParticipation` | `post-service`   | Post→Map HS256 서비스 JWT 사용                   |
| User        | `UserService.GetUserProfile`              | `post-service`   | User 수신 검증 구현; 실제 Post 클라이언트 미연결 |
| User        | `UserService.BatchGetUserProfiles`        | `post-service`   | User 수신 검증 구현; 실제 Post 클라이언트 미연결 |

현재 User gRPC의 `GetUserStatus`는 `ws-gateway`를 허용하도록 구현되어 있지만
실제 WS 클라이언트는 연결되지 않았다. **목표 권한표에서 Gateway의 gRPC 호출은
허용하지 않는다.** WS Gateway가 계정 상태를 조회해야 한다면 아래 User 내부
HTTP 경로를 구현한다. 기존 gRPC 메서드는 소비자가 없음을 확인한 뒤 계약과
서버에서 제거한다.

### Gateway→도메인 서비스: 내부 HTTP

| 수신 서비스 | HTTP 작업                                   | 목표 허용 호출자 | 현재                                                                     |
| ----------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| Post        | `GET /internal/v1/posts/{postId}/status`    | `ws-gateway`     | WS→Post HS256 서비스 JWT 사용                                            |
| Post        | `GET /internal/v1/posts/{postId}`           | `ws-gateway`     | WS→Post HS256 서비스 JWT 사용                                            |
| Post        | `GET /internal/v1/posts/{postId}/comments`  | `ws-gateway`     | WS→Post HS256 서비스 JWT 사용                                            |
| Post        | `POST /internal/v1/posts/{postId}/comments` | `ws-gateway`     | WS→Post HS256 서비스 JWT의 `userId` 사용; 내부 사용자 문맥으로 전환 필요 |
| Map         | `GET /internal/v1/posts/nearby`             | `http-gateway`   | Map 수신 HS256 검증 구현; Gateway 호출 미연결                            |
| User        | `GET /internal/v1/users/{userId}/status`    | `ws-gateway`     | 제안 경로; HTTP 계약·구현 없음                                           |

User 상태 조회 HTTP 경로는 `GetUserStatus`와 같은 계정 상태·정지 기한 정보를
제공하는 **후속 계약 제안**이다. 구현 전에 요청·응답·오류를 User의 HTTP
OpenAPI에 정의한다.

Post의 `GET /internal/v1/posts/{postId}/meta`는 현재 소비자가 확인되지 않아
**목표 허용 호출자를 지정하지 않는다**. `POST /internal/v1/posts/batch-get`은
운영에서 비활성화되어 있어 이 전환으로 열지 않는다. Notification·Moderation의
내부 호출은 계약과 소비자가 생길 때 별도로 추가한다.

HTTP Gateway가 프록시하는 **현재 구현된 공개 API**의 목표 허용 호출자는 아래와
같다. 표의 모든 행은 상류 서비스 JWT로 `http-gateway`를 인증한다. `사용자 필요`는
Gateway가 사용자 Access JWT도 검증하고, 필요한 내부 신원 헤더를 다시 만들어야
한다는 뜻이다. `사용자 불필요`는 공개 진입점이라는 뜻이지 서비스 간 인증 예외가
아니다.

| 수신 서비스 | HTTP 작업                                                                                                                                         | 목표 허용 호출자 | 사용자 인증                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------- |
| User        | `POST /api/v1/auth/kakao`, `POST /api/v1/auth/refresh`                                                                                            | `http-gateway`   | 불필요                            |
| User        | `POST /api/v1/auth/logout`                                                                                                                        | `http-gateway`   | 필요; `x-user-id`, `x-session-id` |
| User        | `GET /api/v1/users/nickname/availability`                                                                                                         | `http-gateway`   | 불필요                            |
| User        | `GET /api/v1/users/me`, `PATCH /api/v1/users/me`                                                                                                  | `http-gateway`   | 필요; `x-user-id`                 |
| User        | `POST /api/v1/users/me/term-consents`, `GET /api/v1/users/me/badges`, `POST /api/v1/users/me/withdrawal`                                          | `http-gateway`   | 필요; `x-user-id`                 |
| Post        | `GET /api/v1/posts/{postId}`, `GET /api/v1/posts/{postId}/comments`                                                                               | `http-gateway`   | 불필요                            |
| Post        | `POST /api/v1/posts`, `POST /api/v1/posts/{postId}/comments`, `POST /api/v1/posts/{postId}/reactions`, `POST /api/v1/posts/{postId}/participants` | `http-gateway`   | 필요; `x-user-id`                 |
| Map         | `PUT /api/v1/location`                                                                                                                            | `http-gateway`   | 필요; `x-user-id`                 |

현재 HTTP Gateway는 사용자 인증을 적용하지 않는 투명 프록시다. 이 표는 **목표
권한**이며 현재 운영에 허용된 경로를 나타내지 않는다. 3단계에서 method·path별로
구현하며 prefix 전체를 허용하지 않는다. User의 로그아웃·프로필 변경, Post의
쓰기, Map의 위치 갱신은 Gateway 사용자 인증과 내부 헤더 정제가 끝나기 전까지
운영에서 열지 않는다. 프록시에 등록된 Notification·Moderation prefix는 구현된
서비스 계약이 없으므로 권한을 아직 부여하지 않는다.

## 4. 전환 순서

1. **공통 규약·권한표 확정.** 이 문서를 기준으로 각 수신 서비스의 공개키
   배포 설정과 기본 거부 정책을 준비한다. 유효한 서명, 변조, 잘못된 `iss`·`sub`·
   `aud`·`typ`·`alg`·`kid`, 만료·미래 발급, 비허용 RPC와 키 교체를 검증한다.
2. **Post→Map 전환.** Map이 전환 기간에 기존 HS256과 새 ES256을 모두 검증하게
   배포한 뒤 Post의 서명을 ES256으로 전환한다. Map의 두 RPC와 위치 거부·장애
   응답 및 deadline 동작을 회귀 검증한다. 기존 방식을 새 호출 관계에 복제하지
   않는다.
3. **User gRPC 및 Gateway→서비스 HTTP 호출 전환.** Post→User의 프로필 조회
   RPC 두 개를 전환하고 Post gRPC 클라이언트를 연결한다. WS→User 상태 조회는
   HTTP 계약을 추가해 HTTP 클라이언트로 연결한다. WS→Post 내부 HTTP,
   HTTP Gateway→Map 주변 조회와 구현된 공개 프록시 경로도 HTTP로 전환한다.
   Gateway 사용자 JWT 검증, 신원 헤더 제거·재작성, 수신 서비스의 서비스 인증을
   함께 적용한다. User의 미사용 `GetUserStatus` gRPC 메서드는 소비자 확인 후
   제거한다. 공개 API의 운영 차단을 인증 연동 전에 해제하지 않는다.
4. **기존 공유 secret 제거.** 각 호출 경로에서 새 방식만 쓰는 것을 확인하고
   HS256 허용 분기를 닫는다. `MAP_SERVICE_JWT_SECRET`,
   `USER_SERVICE_JWT_SECRET`, `WS_SERVICE_JWT_SECRET`, `MAP_GATEWAY_JWT_SECRET`의
   해당 서비스 간 용도를 설정·배포에서 제거한다. **사용자 Access JWT의 키는
   이 제거 대상이 아니다.** 기존 토큰 최대 수명과 배포 중 인스턴스를 고려해
   구 키를 폐기한다.

키를 정기 교체할 때는 새 공개 JWK를 수신 서비스에 먼저 배포하고, 호출자의
서명 `kid`를 바꾼 다음, 이전 토큰의 최대 수명과 배포 겹침이 지난 후 옛
공개키를 제거한다. 개인키 유출 시에는 해당 호출 서비스의 키를 즉시 교체하고
옛 `kid`를 거부한다. 이 경우 유효 기간이 남은 토큰도 실패할 수 있다.


## 유사 게시물 검색 기반의 추가 계약

`MapPostQuery.SearchNearbyPosts`는 ES256으로 인증한 `post-service`만 허용한다. 기존 두 MapAuthorization RPC의 HS256 전환 예외를 신규 RPC에 확장하지 않는다. Post는 기존 두 위치 인가 클라이언트와 동일한 내부 ES256 서명 함수를 사용한다. 자세한 입력/응답은 Map `contracts/map-authorization.proto`에 정의한다.

`POST /api/v1/posts/similar`는 생성과 같은 사용자 인증 정책을 따른다. 현재 로컬·테스트 X-User-Id만 지원하고 운영 사용자 인증 미연결 시 503이다. 목표 Gateway 호출자는 http-gateway이며 사용자 인증/내부 헤더 정제는 기존 전환 선행 조건이다. 모델 미연결도 명시적인 503이며 API 추가가 운영 인증 개방을 뜻하지 않는다.
