# WGO Notification Service

알림 기록, 구독 및 전송을 담당할 독립 서비스의 기본 프로젝트입니다. 이번 초기 세팅에는 NestJS 앱, 환경설정, `GET /health/live`만 포함합니다. Redis, DynamoDB, Firebase 연결이나 알림 비즈니스 로직은 아직 없습니다.

## 로컬 실행

Node.js 24와 pnpm 10을 사용합니다.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

기본 주소는 `http://localhost:3004`입니다. Redis나 DynamoDB가 없어도 앱과 liveness endpoint가 실행됩니다.

```bash
curl http://localhost:3004/health/live
```

응답은 `{ "service": "notification-service", "status": "ok" }`입니다. 이 endpoint는 외부 인프라의 준비 상태를 확인하지 않습니다.

Redis를 별도로 시험할 때만 `docker compose --profile redis up -d`로 로컬 Redis를 실행합니다. 호스트 포트는 다른 서비스와 겹치지 않는 6382입니다. 현재 앱은 Redis에 연결하지 않습니다.

## 환경변수

| 이름                                | 용도                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                          | 실행 환경 (`.env.example`은 `development`)                         |
| `PORT`                              | HTTP 포트; 기본값 3004, 양의 정수가 아니면 시작 실패               |
| `REDIS_URL`                         | 향후 Redis Streams 및 캐시에 사용할 주소                           |
| `AWS_REGION`                        | 향후 DynamoDB에 사용할 AWS 리전                                    |
| `DYNAMODB_ENDPOINT`                 | 향후 DynamoDB endpoint (로컬 개발 시 사용 가능)                    |
| `DYNAMODB_NOTIFICATIONS_TABLE`      | 향후 `NOTIFICATIONS` 테이블 이름                                   |
| `DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE` | 향후 `PUSH_SUBSCRIPTIONS` 테이블 이름                              |
| `FIREBASE_PROJECT_ID`               | 향후 Firebase 프로젝트 ID                                          |
| `FIREBASE_CLIENT_EMAIL`             | 향후 Firebase 서비스 계정 이메일                                   |
| `FIREBASE_PRIVATE_KEY`              | 향후 Firebase 서비스 계정 개인키; 실제 값은 저장소에 커밋하지 않음 |

현재 외부 서비스용 변수는 선택 사항이며, 값을 설정해도 클라이언트가 생성되거나 연결되지는 않습니다.

## 검증

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 후속 작업

- Post Redis Stream event consumer
- Moderation/Lifecycle event consumer
- DynamoDB Notification 저장
- Push Subscription 관리
- FCM Push
- 2분 Window 묶음 알림
- dedup
- unread cache
- Realtime Gateway 연동

이벤트 형태와 수신자 판단은 후속 PR에서 확정합니다.
