# 최종 QA: 프로필 이미지 (2026-11-17, Asia/Seoul)

## 원인과 확인 범위

운영 설정 장애를 재현했다. User 런타임 코드는 수정하지 않는다.

- 실제 `user-service` 앱 프로세스: `GCS_PROFILE_ENABLED=true`,
  `GCS_PROFILE_BUCKET=project-103a7af1-0f7c-4697-972-wgo-demo-media`.
  기존 보고서 당시의 잘못된 `-profiles` 버킷 설정은 현재 해소돼 있다.
- KSA `wgo-demo/user-service` → GSA
  `wgo-demo-user@project-103a7af1-0f7c-4697-972.iam.gserviceaccount.com`.
  Pod metadata의 실제 계정과 annotation이 일치한다. 별도 credential 파일은 없다.
- Pod에서 기존 `@google-cloud/storage` SDK로 **URL만 서명**해 보았다.
  `iam.serviceAccounts.signBlob` 권한 거부가 발생했다. 객체는 만들지 않았다.
  기존 adapter는 이를 URL 발급 단계의 HTTP 503 `Profile image signing unavailable`로 변환한다.
  Signed GET 발급도 같은 서명 권한이 필요하다.
- 존재하지 않는 진단용 pending 객체에 metadata GET만 실행했다.
  HTTP 403, `storage.objects.get` 거부를 확인했다. PUT·copy·delete는 실행하지 않았다.
  따라서 서명만 고쳐도 complete의 metadata/바이트 검증이 막힐 수 있다.
- 공유 버킷 IAM에는 Post GSA의 objectAdmin만 있고 User의 직접 객체 grant는 없다.
  project에서 User 직접 binding은 cloudsql.client/instanceUser다.
  GSA 자체 정책에는 Workload Identity binding만 있고 서명 grant가 없다.
  `projects/.../roles/wgoProfileObjects`도 NOT_FOUND다.
  상위 조직·그룹 등 모든 유효 IAM을 인증한 결과는 아니지만 위 두 권한 거부는 실제 런타임으로 확인했다.
- UBLA=true, Public Access Prevention=enforced.
  현재 CORS는 GET/HEAD/PUT, `https://wgo-now.vercel.app`, localhost 5173/3000,
  Content-Type/Content-Length/ETag/x-goog-generation/x-goog-if-generation-match/Range를 포함한다.
  CORS를 변경할 근거는 없다.

최근 24시간/최대 10,000줄의 User 로그에서는 프로필 URL GET 200 5건만 확인했다.
업로드 POST 실패 요청의 실제 사용자 trace는 이 범위에 없었다. 브라우저에서 어느 요청이 실패했는지
직접 관찰한 결과로 과장하지 않는다. 위 진단은 런타임 의존성의 재현 결과다.
GET 200은 사진이 없는 사용자의 null URL 응답일 수도 있어 GCS 읽기 성공의 증거가 아니다.

## 프론트 계약

2026-11-17 읽기 전용 GET으로 배포 웹의 `/assets/index-DRIPodCV.js`에서 업로드/complete/URL 경로를 확인했다.
별도 로컬 프론트 checkout `77cd15751174e3033ec9b0675744fa460c88454a`의
`src/api/profileImage.ts`는 아래 계약과 일치한다. 해당 checkout과 배포 번들의 소스 동일성까지 검증하지는 않았다.
현재 근거로 프론트 오호출을 장애 원인으로 분류하지 않는다.

1. Gateway에 Access JWT로 `POST /api/v1/users/me/profile-image/uploads`.
   body는 `{ "contentType": "image/jpeg", "sizeBytes": 12345, "checksum": "<원본 업로드 바이트의 SHA-256 base64>" }`.
   MIME JPEG/PNG/WebP, 크기 1..2097152 bytes. 응답 201.
2. 응답 `uploadUrl`에 응답 `method: PUT`, 응답 headers와 원본 Blob 전송.
   FormData, 앱 Authorization, 앱 쿠키를 보내지 않는다. Content-Type과 실제 길이가 서명과 같아야 한다.
3. PUT 성공 후 `POST /api/v1/users/me/profile-image/uploads/{uploadId}/complete`, Access JWT, 응답 200.
4. `GET /api/v1/users/me/profile-image/url`로 받은 `url`을 이미지 src로 사용한다.
   필요 시 `GET /api/v1/users/me`로 현재 키를 갱신한다. URL/업로드 완료 기한은 300초다.
5. 삭제는 기존 `PATCH /api/v1/users/me`, `{ "profileImageKey": null }`이다.

## 로컬 검증 및 기존 기능 보존

- Node 24.22.3, 별도 PostgreSQL 18/Redis 8 컨테이너, 기존 GCS 바이트 테스트 대역.
- 기존 profile-image-config/storage: **26 통과**.
- 기존 profile-image.integration: **27 통과, Gateway 선택 테스트 1 skip**.
  업로드 → PUT 대역 → complete → 조회, 교체/삭제, 서명/객체 권한 실패, 바이트 검증,
  멱등성·트랜잭션 실패 복구·Post 객체 보호가 포함된다.
- 합계 **53 통과, 1 skip**. 실제 GCS CORS·브라우저·GCS PUT/complete E2E는 미실행이다.
- User 소스, API/OpenAPI, Proto, migration, 기존 테스트는 기준 main과 동일하다.
  새 회귀 테스트를 중복 추가하지 않고 이미 있는 권한 실패 테스트를 실행했다.
- 이 이슈의 변경 파일은 이 보고서 하나다. 기존 두 QA 보고서는 과거 기록으로 보존한다.

## 승인 후 필요한 운영 작업 — 이번 작업에서는 실행하지 않음

기존 bootstrap을 통째로 apply하지 않는다. 현재 정책을 보존하는 좁은 변경 계획을 별도로 승인받는다.

1. 기존 설계의 custom role `wgoProfileSigner`에 signBlob만 포함하고 User **자기 GSA**에 부여한다.
   광범위 TokenCreator를 추가하지 않는다.
2. custom role `wgoProfileObjects`에 storage.objects.create/get/delete만 포함하고 공유 버킷에
   `resource.name.startsWith('projects/_/buckets/<공유버킷>/objects/user-profiles/')` 조건으로 User GSA에 부여한다.
   list·버킷 관리·Post prefix 권한은 주지 않는다. 적용 전 custom role 존재/권한 drift와 유효 IAM을 재검토한다.
3. 버킷 env는 이미 맞으므로 변경하지 않는다. Secret 우선순위, 기존 CORS·lifecycle·Post IAM을 보존한다.
4. 승인된 별도 테스트 계정으로 발급 → 브라우저 GCS PUT → complete → Signed GET 바이트 확인,
   교체·삭제·기한 만료·재시도를 수행한다. 이는 객체·DB 변경을 수반하므로 현재 실행하지 않았다.

운영 IAM/Secret/DB/GCS 객체 변경, 실제 업로드, 실제 FCM, 배포 및 원격 Git 작업은 수행하지 않았다.
운영 적용이 남아 있으므로 운영 QA 해결 완료로 표기하지 않는다.
