# 최신 dev 통합 배포 인계

기준: origin/dev `77691c92e41ade61da037cf93549f14a6078a147` (2026-11-01). 이 작업은 로컬 구현·검증·커밋까지만 수행한다.

- Gateway는 차단 POST/GET/DELETE(동적 ID 포함), 호환 PUT/DELETE body, 신고 POST/DELETE를 사용자 인증 뒤 전달한다. 외부 X-User-Id를 제거하고 검증된 ID를 재작성한다. ES256 서비스 토큰의 User/Moderation audience를 구분한다. Moderation은 서명된 userId와 헤더를 대조한다. User의 기존 서비스 인증·readiness 예외는 유지한다.
- 통합 Swagger는 양 서비스의 실제 OpenAPI를 병합하며 내부 identity header와 서비스 토큰 대신 사용자 Access JWT를 안내한다.
- Moderation은 PostgreSQL을 사용하지 않는다. `moderation:reports:v1:records` HASH에 원본·journal·발행 receipt, `moderation:reports:v1:pending` SET에 복구 대상을 저장한다. 기존 키·Stream·Consumer Group을 초기화하지 않는다. Redis 원본은 TTL 없이 보존하므로 용량·보존·익명화 정책이 필요하다.
- GKE Redis의 TLS/CA, AOF always, noeviction, PVC/백업 구성을 그대로 이용한다. 배포 설정이나 Secret을 이 작업에서 변경하지 않는다. 단일 노드 장애·백업 이후 RPO는 별도 운영 검증이 필요하다. User/Notification Cloud SQL은 유지한다.
- **배포 전 설정 필요:** Moderation→Post [전용 대상 검증 계약](reports.md)을 구현했다. 별도 ES256 키, POST_MODERATION_TRUSTED_JWKS, MODERATION_POST_REPORT_TARGET_URL, MODERATION_SERVICE_PRIVATE_JWK를 배포 환경에서 연결해야 한다. 미설정이면 신규 접수503이다. REPORTS_POST_SERVICE_URL만으로 열리지 않으며 기존 WS/Gateway 키를 공유하지 않는다. 실제 GCP에서 인증·대상 상태·장애 응답을 검증해야 한다.
- dev의 과거 `targetId`·자유문자열 사유 신고 API는 `postId`/`commentId`·enum 사유·description 계약으로 바뀐다. 기존 신고 키를 자동 이관하지 않는다. 기존 데이터를 보존하는 별도 이관·클라이언트 전환 계획 없이 운영 완료로 판단하지 않는다.

Redis 원본·복구·이벤트 상세는 [신고 계약](reports.md)을 따른다. PR #70의 PostgreSQL 신고 구현을 그대로 merge하지 않는다.
