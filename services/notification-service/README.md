# WGO Notification Service

알림 원본 저장, 조회, FCM 구독·전송과 Post Redis Stream 소비를 담당합니다.

## 실행

Node.js 24와 pnpm 10을 사용합니다.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

기본 HTTP 주소는 `http://localhost:3004`이며 liveness endpoint는 `GET /health/live`입니다. `REDIS_URL`이 비어 있으면 Post 이벤트 consumer는 시작하지 않습니다.

## 구현된 기능

- DynamoDB Notification 생성, 사용자별 최신순 조회와 cursor pagination
- 사용자 소유권을 포함한 읽음 처리와 30일 TTL
- FCM token 등록/upsert, 삭제, 사용자별 token 조회
- Firebase Admin SDK를 통한 복수 token 전송, 부분 실패 보고, invalid token 정리
- Redis event dedup(7일), unread count cache(1일), 동일 사용자·게시물·유형의 2분 묶음 처리
- `post:events`의 `post-notification` Consumer Group, `XREADGROUP`, `XAUTOCLAIM`, graceful shutdown
- Post Service의 schema version 1 envelope와 `PostCreated`, `PostCommentCreated`, `PostReactionCreated`, `PostParticipantJoined` 파싱
- malformed 또는 5회 실패 이벤트를 `notification:post:dead`에 기록한 후 ACK
- 자기 행동 알림 제외

알림 저장이 FCM 전송보다 먼저 완료됩니다. Push 실패 시 DynamoDB의 알림 원본은 유지되고 이벤트는 ACK되지 않아 재처리 대상이 됩니다.

## HTTP API

Gateway가 인증 후 설정한 `X-User-Id`를 사용자 문맥으로 사용합니다. body나 query의 userId는 받지 않습니다.

| Method | Path | 기능 |
| --- | --- | --- |
| `GET` | `/api/v1/notifications` | 내 알림 목록 (`limit`, `cursor`) |
| `GET` | `/api/v1/notifications/unread-count` | 읽지 않은 알림 수 |
| `PATCH` | `/api/v1/notifications/{notificationId}/read` | 내 알림 읽음 처리 |
| `PUT` | `/api/v1/notifications/push-subscriptions` | FCM token 등록/upsert |
| `DELETE` | `/api/v1/notifications/push-subscriptions` | FCM token 삭제 |

## DynamoDB 테이블

`DYNAMODB_NOTIFICATIONS_TABLE`은 partition key `userId`, sort key `notificationId`를 사용합니다. `notificationId`는 ISO 시각으로 시작해 사용자 partition에서 역순 조회할 수 있습니다. `expiresAt`을 TTL attribute로 설정합니다.

`DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE`은 partition key `userId`, sort key `token`을 사용합니다.

## 현재 외부 계약 blocker

- 댓글·LIKE 알림 수신자는 게시물 작성자입니다. Post의 내부 `GET /internal/v1/posts/{postId}/meta`가 작성자를 반환하지만 현재 서비스 인증 권한표에 `notification-service` 호출 권한이 없습니다. 권한표, Post 수신 검증, Notification의 ES256 호출 설정이 확정되어야 실제 resolver를 연결할 수 있습니다.
- `PostCreated`의 좌표는 확인할 수 있지만 Map Service에는 150m 주변 사용자 ID 조회 계약이 없습니다. 주변 게시물 조회 API로 대체하지 않습니다.
- 답글, 댓글 반응, 확장 reaction 종류, 종료 예정·종료 및 Moderation 알림 EventType과 payload 계약이 없습니다.
- `PostParticipantJoined`는 파싱하고 ACK하지만 현재 알림 기능 명세가 없어 알림을 만들지 않습니다.
- HTTP Gateway의 Notification 경로 인증·권한 계약이 아직 확정되지 않았습니다. Controller는 기존 내부 사용자 헤더 convention을 따르지만 운영 공개 전 Gateway 인증 연결이 필요합니다.

## 환경변수

| 이름 | 용도 |
| --- | --- |
| `PORT` | HTTP 포트, 기본값 `3004` |
| `REDIS_URL` | Post Stream, dedup, unread cache와 bundle 상태에 사용할 Redis |
| `AWS_REGION` | DynamoDB region |
| `DYNAMODB_ENDPOINT` | 로컬 DynamoDB용 선택 endpoint |
| `DYNAMODB_NOTIFICATIONS_TABLE` | Notification 테이블 |
| `DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE` | Push subscription 테이블 |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Firebase private key. 환경변수의 `\\n`은 실제 줄바꿈으로 변환됩니다. |

## 검증

```bash
pnpm test
pnpm typecheck
pnpm build
```

단위 테스트는 AWS와 Firebase credential 없이 실행되며 DynamoDB repository, Firebase Messaging, Redis 명령을 대역으로 검증합니다.
