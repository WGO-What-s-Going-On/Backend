# Gateway 및 팀별 후속 변경 요청

Gateway/Post/Map/Notification 코드는 수정하지 않았다. CloudFront https://d35lxgeutzw8c6.cloudfront.net/docs 문서·운영 자원도 변경하지 않았다.

## HTTP Gateway 담당자

1. gateways/http-gateway/src/user-auth.ts의 userOperations/userAuthentication에 POST·GET /api/v1/users/me/blocks, DELETE /api/v1/users/me/blocks/{blockedUserId}를 사용자 필수로 등록한다. 현재 exact lookup은 동적 DELETE를 매칭하지 못한다. 런타임의 decimal path와 OpenAPI template를 함께 처리하되 prefix 전체 허용은 하지 않는다. User 수신 guard는 신규 3개 작업을 허용한다.
2. src/app.ts의 Moderation 프록시에 POST /api/v1/moderation/reports, DELETE /api/v1/moderation/reports/{reportId}만 인증해 전달한다. 사용자 Access JWT 검증 후 클라이언트 Authorization/X-User-Id/X-Session-Id 및 중복 헤더를 제거하고 검증된 sub로 내부 X-User-Id를 작성한다.
3. User 인증 함수를 복사해 audience까지 재사용하지 않는다. Moderation 서비스 JWT는 ES256, issuer wgo-http-gateway, subject http-gateway, audience wgo-moderation-service, typ wgo-service+jwt, 등록된 kid, iat/exp 최대60초다. User audience는 wgo-user-service다. 수신 공개키는 MODERATION_HTTP_GATEWAY_TRUSTED_JWKS로 별도 배포한다. 미설정 인증에서는 503/닫힌 상태를 유지한다.
4. src/routes.ts의 기존 /api/v1/moderation prefix/rewrite가 동일 서비스 경로로 전달되는지 검증한다. prefix 존재만으로 인증이 구현된 것은 아니다.
5. src/openapi.ts의 documentedServices에 moderation을 추가하고 undocumentedServices에서 제거한다. mergeDocuments의 현재 source.service === 'user' 전용 변환을 Moderation에도 적용한다. 내부 service-jwt/X-User-Id를 공개 계약에서 제거하고 사용자 bearer JWT만 표시한다. 현재 User 변환은 userOperations에 없는 새 경로를 제거하므로 차단 3개 경로 및 dynamic DELETE template를 반영해야 한다. 단순 수집 추가만 하면 내부 인증 참조 검증에 실패한다.
6. src/docs-generate.ts의 generateDocs는 documentedServices를 기반으로 /docs/openapi.json을 수집한다. MODERATION_SERVICE_URL/timeout·실패 정책/수집 fixture를 갱신한다. Gateway /docs, /docs/openapi.json은 유지한다.
7. test/user-auth.test.ts, test/app.test.ts: 5개 endpoint·동적 path, 사용자 토큰 누락/변조/만료, forged/duplicate headers, 잘못된 method/path, 상류 audience, 미설정 인증, body/status 전달을 검증한다.
8. test/openapi.test.ts: Moderation fixture/필수 서비스 수집, 5개 작업, schema namespace, 누락/잘못된 문서, 사용자 bearer 변환, 내부 헤더/service-jwt 제거, 기존 4개 서비스 회귀와 validation을 검증한다.
9. 로컬 통합 문서 생성 후 승인된 서비스/Gateway 배포·CloudFront 문서 갱신을 수행한다. 서비스 Swagger 테스트 성공은 통합/운영 반영 완료가 아니다.

현재 Gateway는 User 신규 작업을 allowlist에서 거부하고 Moderation은 문서 수집 대상이 아니다. 따라서 이번 코드만으로 배포 Gateway를 통한 프론트엔드 연동은 완료되지 않는다.

## Post 담당자

단건 신고 대상 검증 API를 확정한다. post/comment 소속 및 ACTIVE/삭제/만료 확인, Moderation 호출자 서비스 인증을 구현한다. 기존 ws-gateway 내부 권한을 재사용하지 않는다. 현재는 기존 공개 읽기를 최대10페이지/3초로 검증하므로 댓글이 많은 경우 503이 될 수 있다. 검증과 신고 저장 사이 삭제는 감사 기록으로 허용하는 정책이다.

## 인프라·보안·제품 담당자

Moderation 전용 PostgreSQL/DB 계정/TLS/백업/PITR/복구, migration 실행, Secret/JWK와 키 교체, Redis ACL/보존/관측을 준비한다. 신고 설명·신고자 ID·이벤트 보존/익명화 정책과 API abuse rate limit을 확정한다. DB 미설정 503/JWKS 미설정 401을 무인증 우회로 해결하지 않는다. 새 DB 어댑터의 RDS IAM 토큰 자동 회전은 별도 작업이다.

Moderation은 Gateway 사용자 인증 문맥을 사용한다. 신고자의 최신 정지/탈퇴 상태를 매 요청 조회하는 기능은 현 Gateway Access JWT 계약에 없으므로 필요 시 별도 상태 검증을 연결한다.

## 소비 서비스 담당자

Notification/Post/리뷰 도구의 신규 이벤트 소비는 아직 없다. 서비스별 Consumer Group, eventId 중복 방지/부작용 원자 처리, 저장 후 XACK, Pending 회수/DLQ/보존·복구를 구현한다. User block은 원본 관계 조회/재동기화 계약과 이벤트 순서 역전을 함께 다뤄야 한다. 현재 서비스 간 관계 조회 API는 없으므로 그 계약도 별도 합의가 필요하다. 신고 접수는 제재 결정이 아니다.
