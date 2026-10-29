# 병합 후 Gateway 및 팀별 후속 요청

최신 dev 9176d57을 feat/user-blocks-moderation-reports에 통합한 상태를 기준으로 한다. Gateway/Post/Map/Notification의 변경은 dev에서 가져온 것이며 이 충돌 해결에서 해당 서비스를 별도 수정하지 않았다. 운영 배포·CloudFront 문서 갱신은 수행하지 않았다.

## 이미 dev에서 반영된 부분

- HTTP Gateway는 Moderation에도 사용자 JWT 검증과 ES256 서비스 토큰을 적용한다. audience=wgo-moderation-service, userId claim과 내부 X-User-Id를 전달한다. 수신 guard도 두 사용자 ID의 일치를 검증한다. 개발 무인증 우회는 허용하지 않는다.
- Moderation은 documentedServices에 포함되어 있고 모든 서비스의 내부 인증/헤더를 공개 사용자 bearer로 변환하는 로직이 있다. 해당 작업을 중복 요청하지 않는다.
- User의 GET/PUT/DELETE /api/v1/users/me/blocks가 Gateway allowlist에 있다. PUT/DELETE의 `{userId}` 요청은 신규 POST/경로 DELETE와 동일한 PostgreSQL·Outbox 로직으로 처리한다. User 프로필 실명/브라우저 쿠키 변경도 보존했다.

## Gateway 담당자에게 남은 요청

1. src/user-auth.ts의 userOperations/userAuthentication에 POST /api/v1/users/me/blocks와 DELETE /api/v1/users/me/blocks/{blockedUserId}를 사용자 필수로 추가한다. 동적 런타임 경로와 OpenAPI template를 모두 매칭해야 한다. 기존 PUT/DELETE 본문 경로는 유지한다.
2. src/openapi.ts의 User 문서 필터에도 위 두 작업을 포함한다. 현재 allowlist에 없는 User 작업은 통합 문서에서 제거된다. Moderation 수집과 내부 헤더/service-jwt 제거는 이미 dev에 있으므로 새 request/response DTO·신고 DELETE fixture를 갱신한다.
3. test/user-auth.test.ts, test/app.test.ts, test/openapi.test.ts에서 구·신 차단 경로, 동적 DELETE, 인증 누락/위조·중복 헤더, Moderation signed userId 불일치, 새 신고·취소의 body/status 및 공개 Swagger schema를 검증한다.
4. 서비스별 문서/통합 문서를 검증하고 승인된 배포·CloudFront 문서 재생성을 수행한다. 로컬 병합 가능 여부는 운영 반영 완료와 다르다.

## 프론트엔드 계약 전환

차단 PUT/DELETE `{userId}`는 계속 지원한다. 목록은 blockedAt/profileImageKey와 기존 createdAt 별칭을 함께 반환한다. 기본은 ID 내림차순·소유자 포함 opaque cursor이며, 이전 숫자 커서를 받으면 기존 오름차순으로 이어서 조회하고 그 방향을 다음 opaque cursor에 보존한다.

신고는 이번 작업의 검증 가능한 계약인 `{targetType, postId, commentId?, reason, description?}`으로 통합했다. 예전 dev의 `{targetType,targetId,reason:자유문자열}` Redis-only 컨트롤러를 함께 등록하지 않는다. 프론트는 POST 대상에 postId, COMMENT 대상에 부모 postId와 commentId를 보내고 enum 사유·선택 설명을 사용해야 한다. targetId만으로는 댓글의 부모/실제 존재 검증을 충족할 수 없다. 해당 본문은400을 반환하며 무검증 Redis 저장으로 우회하지 않는다. docs/contracts/frontend-integration.md의 기존 신고 항목은 이 계약으로 갱신이 필요하다.

기존 Redis-only 신고 원본 키는 삭제하지 않는다. 새 API는 PostgreSQL을 원본으로 사용하므로 기존 64자리 hash reportId/신고 이력의 운영 이관·감사 정책은 별도 확정해야 한다. 기존 Redis 데이터를 자동으로 변환하거나 삭제하지 않았다.

## Post 담당자

최신 dev의 공개 Post 조회도 운영에서 Gateway 서명/userId를 요구한다. 현재 ReportTarget의 서비스 직접 읽기는 이 권한을 갖지 않으므로 운영에서는 검증503으로 안전하게 거부된다. Moderation용 단건 post/comment 대상 검증 API와 서비스 인증 허용 계약을 확정하고 전용 클라이언트를 연결해야 한다. Moderation용 토큰을 Post audience로 재사용하거나 Gateway 키를 Moderation에 배포하지 않는다. 기존 ws-gateway 내부 권한도 사용하지 않는다. 이 부분과 Moderation DB가 준비되기 전 신고 운영 접수는 완료가 아니다.

로컬 Post 테스트 환경에서는 기존 읽기 계약으로 부모 ACTIVE/미만료·댓글 소속/ACTIVE를 전체3초·최대10페이지 안에 검사한다. 401/403/장애·탐색 한도는503이며 미검증 신고를 저장하지 않는다. 취소는 Post 가용성에 의존하지 않는다.

## 인프라·제품·소비 서비스

Moderation 전용 PostgreSQL/계정/TLS/백업/PITR/복구·migration/Secret/JWK, Redis ACL·관측, 신고 이력·설명·사용자 ID의 보존/익명화를 준비한다. DB 미설정503/JWKS 미설정401을 우회하지 않는다. 신규 DB 어댑터의 RDS IAM 자동 회전은 별도 작업이다.

Notification/Post/리뷰 도구의 신규 이벤트 소비는 아직 없다. 서비스별 Group·eventId 중복 방지/부작용 원자 저장, 저장 후 XACK, Pending 회수/DLQ, 관계 원본 재동기화 계약을 합의한다. 단순 신고는 제재 결정이 아니다.
