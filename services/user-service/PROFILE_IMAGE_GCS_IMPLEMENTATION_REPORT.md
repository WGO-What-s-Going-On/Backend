# User Service 프로필 이미지 구현·운영 인계

작성일: 2026-11-02 (Asia/Seoul).

## 1. 브랜치와 기준

- 기존 `feat/user-profile-presigned-URL`에서 작업했다. 새 브랜치를 만들지 않았다.
- 시작 시 작업 트리는 깨끗했고 HEAD는 `f7002cf6b36ed03f5bd0a8b91d9a02493ae052b6`이었다.
- `git fetch origin dev` 후 최신 `origin/dev` 두 커밋을 fast-forward했다.
- 기준 dev SHA: `c5184f6db6586dc09249f7f8d298d3169aa296a1`.
- push, PR, 원격 merge, 실제 GCP 변경 및 배포는 하지 않는다. 최종 로컬 커밋 SHA는 작업 완료 응답과 `git log -1 --format=%H`에서 확인한다.

## 2. 기존 코드 분석과 호환성

User는 PostgreSQL/TypeORM을 소유한다. `users.profile_image_key`를 그대로 사용한다. 기존 프로필 변경은 사용자 행을 `FOR UPDATE`로 잠그고 Outbox와 함께 커밋하며, 온보딩 완료 전에는 이미지 변경 이벤트를 발행하지 않는다. 이 규칙을 새 완료 API에도 적용했다. 새 이미지가 온보딩을 완료시키지는 않는다.

Post의 `gcs-media.storage.ts`, `media.service.ts`, `media.controller.ts`, `media.config.ts`, `media.policy.ts`, `media.openapi.ts` 및 cleanup worker를 검토했다. V4 PUT → 실제 바이트 검증 → 생성 전용 최종 객체 복사, immutable generation, 재시도 가능한 정리 방식을 User 안에 독립 구현했다. Post 코드·Mongo 모델·기존 IAM은 변경하지 않는다.

기존 다른 사용자 응답은 User gRPC `GetUserProfile/BatchGetUserProfiles` 및 차단 목록의 `profileImageKey`다. Post의 `UserProfiles.names()`는 현재 닉네임만 사용한다. 이 저장소에는 클라이언트 UI 구현이 없어 실제 프론트 이미지 소비 코드를 확인할 수 없다. 키 응답과 gRPC 계약은 유지하고, 인증된 클라이언트가 대상 userId로 URL을 얻는 별도 경로를 추가했다. 차단 목록에 키가 있어도 새 URL 조회는 양방향 차단 시 404이다.

`PATCH /api/v1/users/me`의 **모든 non-null profileImageKey 입력은 400**이다. 빈 문자열이나 자기 키 재입력도 허용하지 않는다. HTTP와 UsersService 양쪽에서 강제한다. `profileImageKey: null` 제거는 유지한다. 기존 nickname/realName 처리, 이벤트 형식, JWT/OAuth/차단/신고/탈퇴 처리는 보존한다. 문자열 설정을 사용하던 클라이언트는 아래 업로드 흐름으로 전환해야 한다.

기존 DB 키는 삭제·변환·검증 강제하지 않는다. 정리 대상도 새 업로드 테이블이 소유하는 객체에 한정한다. 기존 키의 실제 객체 위치는 코드에 정의되어 있지 않으므로, 운영자는 기존 객체가 새 전용 버킷에 있는지 확인하거나 별도의 이관 계획을 세워야 한다. 이 작업은 기존 버킷 객체를 자동 이관하지 않는다. 기존 키가 다른 버킷을 가리키는 환경에서는 그 키의 GET URL로 실제 파일을 읽는 것을 보장하지 않는다.

## 3. 확정한 저장·복구·동시성 설계

전용 비공개 `<project>-<namespace>-profiles` 버킷을 선택했다. 기존 Post 버킷 공유는 버킷 수가 적지만, User에게 Post 객체 접근권을 주거나 복잡한 prefix 조건을 운영해야 한다. 별도 버킷 하나로 권한과 수명주기를 분리하는 편이 현재 구조에서 단순하다.

- 허용 형식: JPEG, PNG, WebP. 파일 크기: 1..2,097,152 bytes.
- 업로드/조회 URL은 모두 300초. 업로드의 완료 가능 기한도 발급 후 300초다.
- UUID v4를 서버가 생성한다. 임시 키는 `user-profiles/pending/<uploadId>`, 최종 키는 `user-profiles/objects/<uploadId>`다. 사용자 입력으로 bucket/key를 받지 않는다.
- PUT 서명에 정확한 Content-Length, Content-Type과 `x-goog-if-generation-match: 0`을 바인딩한다. 덮어쓰기를 허용하지 않는다.
- 검증 시 metadata 크기/MIME와 실제 스트림 길이/SHA-256/Magic Bytes를 확인한다. 읽기와 복사는 같은 generation을 사용한다. 전체 파일을 메모리에 모으지 않고 Magic Bytes용 최대 8KiB만 보관한다.
- 최종 객체 복사도 `ifGenerationMatch: 0`이다. 응답 유실 후 재시도하면 기존 최종 객체의 실제 바이트를 재검증하여 성공한 복사를 복구한다. 임시 객체가 사라졌어도 복구할 수 있다.
- GCS SDK 요청 timeout 15초, 최대 retry 2회/totalTimeout 30초, 스트림 읽기 timeout 15초다. 외부 오류에 서명 URL이나 SDK 인증 세부사항을 노출하지 않는다.

완료는 두 개의 로컬 트랜잭션이다. 첫 트랜잭션은 owner → upload 순서로 잠그고 검증·복사 후 VERIFIED를 저장한다. 두 번째는 같은 순서로 잠그고 사용자 키·APPLIED 상태·기존 형식의 USER_PROFILE_UPDATED Outbox를 원자적으로 저장한다. 그 사이 종료되면 VERIFIED에서 재시도한다. 첫 DB 저장이 실패하면 PENDING에 남지만 UUID 최종 객체를 다시 검증할 수 있다. 두 번째 저장 실패는 기존 프로필과 Outbox를 함께 롤백한다.

동일 업로드의 중복 complete는 한 번만 적용·발행한다. APPLIED 이력 재요청은 `{status:"APPLIED",isCurrent:...}`를 반환하며, 이미지 교체·삭제 후 재요청해도 옛 이미지를 복원하지 않는다. 이미 APPLIED인 이력은 5분이 지나도 재확인할 수 있다. 서로 다른 업로드는 사용자 잠금으로 직렬화하며 **마지막 프로필 적용 트랜잭션의 커밋이 이긴다**. 업로드 URL 발급 순서로 우선순위를 정하지 않는다. 프론트는 최종 상태를 GET /users/me와 URL API로 다시 읽어야 한다.

검증 중 잠금을 유지하는 선택은 GCS/DB 정리 경쟁을 단순하게 막지만, 큰 지연 시 같은 사용자의 PATCH/차단/탈퇴가 기다릴 수 있다. 파일 2MiB와 SDK 제한을 전제로 선택했으며 고부하 시 별도 lease/claim 구조를 검토할 수 있다. Gateway 기본 upstream timeout은 5초이므로 complete가 504/502를 반환해도 서버가 커밋할 수 있다. **같은 uploadId로 재시도**해야 하며 Gateway는 POST를 자동 재시도하지 않는다.

## 4. API·프론트엔드 연동 계약

모든 경로는 Gateway 기준이다. `/api/v1`을 생략하지 않는다. WGO API에만 `Authorization: Bearer <Access JWT>`를 보낸다. `x-user-id`는 클라이언트가 보내지 않는다.

| Method / path | 성공 응답 | 규칙 |
| --- | --- | --- |
| POST `/api/v1/users/me/profile-image/uploads` | 201, uploadId/uploadUrl/method/headers/expiresAt | ACTIVE 사용자만 |
| POST `/api/v1/users/me/profile-image/uploads/:uploadId/complete` | 200, uploadId/status/profileImageKey/isCurrent | 업로드 소유자, 검증 성공 후 적용 |
| GET `/api/v1/users/me/profile-image/url` | 200, profileImageKey/url/expiresAt | 이미지 없으면 세 필드 모두 null |
| GET `/api/v1/users/:userId/profile-image/url` | 동일 | ACTIVE 요청자, ACTIVE·온보딩 완료 대상, 양방향 미차단 |
| PATCH `/api/v1/users/me` `{ "profileImageKey": null }` | 기존 UserProfileResponse | 현재 이미지 제거 |

새 API 응답에는 `Cache-Control: no-store`가 붙는다. GCS 최종 객체도 `private, no-store`다. URL은 비공개 bearer capability이므로 URL/헤더/전체 응답을 콘솔·분석 이벤트·영속 캐시에 기록하지 않는다. 이미 발급된 GET URL은 차단 후에도 최장 5분간 쓸 수 있다. URL 회수가 필요한 보안 모델에서는 프록시 조회 등 별도 설계가 필요하다.

업로드 요청 예시:

```json
{
  "contentType": "image/png",
  "sizeBytes": 68,
  "checksum": "<파일 바이트의 SHA-256 Base64, 44자>"
}
```

발급 응답 예시(실제 응답은 UUID/서명을 포함):

```json
{
  "uploadId": "123e4567-e89b-42d3-a456-426614174000",
  "uploadUrl": "https://storage.googleapis.com/<bucket>/<key>?<signature>",
  "method": "PUT",
  "headers": { "Content-Type": "image/png", "x-goog-if-generation-match": "0" },
  "expiresAt": "2026-11-02T02:05:00.000Z"
}
```

브라우저 구현 예시:

```js
async function changeProfileImage(file, accessToken) {
  const api = async (path, options = {}) => {
    const response = await fetch(`/api/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`WGO ${response.status}`);
    return response.json();
  };
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const checksum = btoa(String.fromCharCode(...bytes)); // 32 digest bytes, not the full file
  const upload = await api('/users/me/profile-image/uploads', {
    method: 'POST',
    body: JSON.stringify({ contentType: file.type, sizeBytes: file.size, checksum }),
  });
  const put = await fetch(upload.uploadUrl, {
    method: upload.method,
    headers: upload.headers,
    body: file,
    credentials: 'omit',
    // WGO Access JWT and API-client default headers MUST NOT be attached here.
  });
  if (!put.ok) throw new Error(`GCS ${put.status}`);
  await api(`/users/me/profile-image/uploads/${upload.uploadId}/complete`, { method: 'POST' });
  const profile = await api('/users/me');
  const image = await api('/users/me/profile-image/url');
  return { profile, image };
}
```

브라우저는 Blob/File 길이로 **Content-Length를 자동 설정**한다. 수동으로 이 헤더를 설정하지 않는다. 비브라우저 클라이언트는 선언한 sizeBytes를 Content-Length로 보내야 한다. FormData/multipart로 감싸지 않고 원본 파일 바이트를 보낸다. `file.type`이 비었거나 허용 MIME이 아니면 업로드 전에 사용자에게 안내한다.

완료 응답 예시는 `{ "uploadId":"...", "status":"APPLIED", "profileImageKey":"user-profiles/objects/...", "isCurrent":true }`다. `isCurrent:false`는 해당 업로드가 이미 적용된 이력이나 지금은 다른 이미지/삭제 상태임을 의미한다. 응답의 과거 키를 UI 현재 상태로 덮어쓰지 않는다.

조회 응답 예시는 `{ "profileImageKey":"user-profiles/objects/...", "url":"https://storage.googleapis.com/...", "expiresAt":"..." }`다. 이미지 없음은 `{ "profileImageKey":null, "url":null, "expiresAt":null }`이므로 기본 아바타를 표시한다. 만료 전 갱신하거나 이미지 GET이 403이면 WGO URL API를 다시 요청해 새 URL을 사용한다. URL 취득 후 브라우저가 이미지를 직접 읽으므로 `<img referrerPolicy="no-referrer">`도 권장한다. 차단·탈퇴 등 WGO URL 조회 404이면 기존 이미지를 지운다.

### 오류와 재시도

User 오류 형식은 기존 Nest `{statusCode,message,error}`이며 Gateway는 기존 `{code,message,requestId,timestamp}` 형식을 유지한다.

| 상태 | 의미 | 클라이언트 동작 |
| --- | --- | --- |
| 400 | 잘못된 MIME/크기/checksum/ID, 알 수 없는 필드, PATCH 문자열 키 | 입력을 수정한다. 같은 입력으로 자동 재시도하지 않는다. |
| 401 | 사용자 JWT 또는 서비스 인증 오류 | WGO 기존 토큰 갱신/로그인 정책을 따른다. GCS에 JWT를 보내지 않는다. |
| 403 | WGO 비활성 요청자; GCS는 서명·헤더·만료 오류도 403 | WGO는 계정 상태 확인. GCS는 expiresAt와 정확한 헤더/바이트 확인. |
| 404 | 업로드 부재/타인 소유, 대상 프로필 부재/비공개 상태/양방향 차단 | 대상이 없다는 동일 정책. 권한 우회 재시도 금지. |
| 409 | 미적용 업로드 기한 만료 | 새 업로드를 발급받아 파일부터 다시 전송한다. |
| 422 | 파일 부재, metadata/실제 길이/MIME/SHA-256/Magic Bytes 불일치 | PUT 미완료인지 확인. 바이트 불일치면 새 업로드로 재시작한다. |
| 500/503/502/504 또는 응답 유실 | DB/스토리지/네트워크 장애. 원격 부작용이 성공했을 수 있음 | 짧은 지수 backoff로 같은 uploadId의 complete를 재시도한다. 미적용 기한 이내에 복구되지 않으면 새 업로드. |
| GCS PUT 412 | 동일 임시 키에 이미 객체가 있음 | PUT 응답 유실일 수 있으므로 같은 uploadId complete로 서버 검증을 시도한다. |

삭제는 `PATCH /api/v1/users/me`에 `{ "profileImageKey": null }`을 전송한 후 GET /users/me 및 URL API로 다시 조회한다. GCS 객체를 프론트가 직접 삭제하지 않는다. 완료 후 발급받은 URL은 최장 5분 유효할 수 있다.

## 5. DB 변경

`ProfileImageUploadEntity`와 `1793570000000-AddProfileImageUploads` migration을 추가하고 런타임 entity 목록 및 CLI DataSource에 등록했다. 기존 users 컬럼이나 데이터를 변경하지 않는다. synchronize는 계속 false다.

테이블은 owner FK, 업로드/최종 객체 키의 UNIQUE, MIME/크기/상태 CHECK, SHA-256, 생성·만료·검증·적용·retiredAt·cleanupAt을 저장한다. cleanupAt과 ownerId 인덱스를 추가했다. 상태는 PENDING, VERIFIED, APPLIED, EXPIRED다. APPLIED 이력은 대체/삭제 후에도 멱등 응답을 위해 유지한다.

배포 전 기존 migration job으로 migration을 먼저 실행한다. 기존 버전과 혼재 중 새 API를 먼저 노출하지 않는다. 롤백은 새 요청을 차단하고 기능을 비활성화한 후 판단한다. 테이블 down은 프로필 이미지 키를 되돌리지 않고 복구·정리 이력을 삭제하므로 운영에서 무조건 실행하지 않는다. 테스트는 임시 DB에서 실제 migration up을 사용했다.

## 6. 정리 및 운영

기존 WithdrawalScheduler/Outbox worker와 Post cleanup worker를 조사했다. 해당 worker는 각자의 도메인 이벤트/탈퇴 작업 전용이다. 별도 큐·CronJob·영구 프로세스를 만들지 않고 User Pod 안의 같은 timer/drain 패턴으로 `ProfileImageCleanupWorker`를 추가했다. 기능 활성화 시 60초마다 최대 20개 후보를 처리한다. 다중 Pod는 같은 owner/upload DB 잠금과 due 재확인으로 조정한다.

업로드 만료 후 15분 유예를 두고 임시 객체를 제거한다. 만료된 미적용 업로드는 EXPIRED로 전환한다. 현재 이미지와 모든 users 행의 동일 최종 키 참조를 보존한다. 참조가 없음을 처음 관찰한 뒤 추가 15분을 기다려 이미 발급된 GET URL의 5분 수명을 보호한다. 최종 키를 재설정할 수 있는 HTTP 경로가 없고 APPLIED 재시도도 복원하지 않으므로 삭제된 객체가 다시 연결되지 않는다. 기존 임의 키에는 업로드 record가 없어 수집하지 않는다.

GCS 삭제/DB 실패 시 기록을 유지한다. tombstone은 지우지 않으며 24시간마다 재확인한다. 이것은 timeout/프로세스 종료 후 뒤늦게 끝난 PUT/copy의 고아 객체까지 다시 지우기 위한 선택이다. 한 객체 실패는 1분 뒤로 미뤄 다음 후보를 계속 처리한다. 버킷 lifecycle의 `user-profiles/pending/` age 1일 삭제는 늦은 PUT의 추가 안전망이며 최종 객체에 일괄 age 삭제를 걸지 않는다. 참조 중인 객체는 임의 삭제하지 않는다.

이력은 현재 무기한 유지하므로 업로드량에 따라 테이블 크기와 cleanup 지연을 관찰해야 한다. 안전한 purge 정책은 진행 중 원격 작업과 APPLIED 멱등성 보장 기간을 정한 뒤 별도로 도입한다. cleanupAt 재시도와 generic 경고 로그를 관찰하고, 장애 복구 후 worker를 실행한다. `runOnce()`는 shutdown 시 현재 sweep 완료를 기다린다. 외부 관리자가 객체를 변경·삭제하는 것은 정상 동시성 모델 밖이다.

## 7. GCP/GKE/IAM/CORS

`scripts/gcp-bootstrap.mjs` dry-run 계획에만 아래 내용을 추가했다. **실제 `--apply`는 실행하지 않았다.**

- 전용 비공개 profiles 버킷: Uniform Bucket Level Access, Public Access Prevention.
- 프로젝트 custom role `wgoProfileObjects`: storage.objects.create/get/delete만. profiles 버킷에서 User GSA에만 binding. list/버킷 관리/Post 접근은 부여하지 않는다.
- custom role `wgoProfileSigner`: iam.serviceAccounts.signBlob만. User GSA가 자기 자신에 대해서만 사용. JSON key나 광범위 TokenCreator를 추가하지 않는다.
- 기존 KSA↔GSA Workload Identity와 ADC/Secret Manager 구조를 재사용한다.
- Post의 기존 media 버킷 및 objectAdmin/서명 binding은 그대로 유지한다.
- 기존 검증된 `webOrigins`만 GET/HEAD/PUT CORS에 적용. Content-Type, Content-Length, ETag, generation/precondition 헤더를 반영한다.
- pending 객체 1일 lifecycle 삭제. profiles 버킷 versioning은 활성화하지 않는다.
- GKE User ConfigMap에 `GCS_PROFILE_ENABLED=true`, `GCS_PROFILE_BUCKET=<project>-<namespace>-profiles`를 렌더링한다. 로컬 .env.example 기본값은 false다. 실제 .env/secret 값은 변경하거나 출력하지 않았다.

기능 활성화 시 bucket 검증, Post 버킷과 같은 이름의 구성 거부, production의 credential JSON 파일·emulator 설정 거부를 적용했다. 기존 리소스나 custom role drift는 bootstrap이 전부 수정하지 않으므로 운영자가 IAM/UBLA/CORS/lifecycle을 확인한다. 워크로드는 storage client가 ADC로 signBlob을 사용할 수 있는 GSA email/token을 얻어야 한다.

공식 근거: [GCS Signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls), [request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions), [canonical signed headers](https://docs.cloud.google.com/storage/docs/authentication/canonical-requests).

## 8. 보안·검증 결과

Gateway는 HS256 Access JWT를 검증해 사용자 문맥을 만들고 ES256 서비스 JWT로 User에 전달한다. 새 고정/동적 경로를 양쪽 allowlist에 명시했다. 외부 x-user-id를 인증으로 사용하지 않는다. User guard는 기존 발급자/대상/typ/kid/수명 검사를 유지한다. Gateway 통합 문서의 경로 template도 추가하여 새 API가 문서화 때 제거되지 않도록 했다.

실제 PostgreSQL과 byte-level GCS double로 소유권, 파일 부재, 만료, MIME/크기/checksum/Magic Bytes 불일치, 미인증, 비활성 사용자, 양방향 차단, 동시 중복·서로 다른 업로드, GCS 응답 유실, VERIFIED 저장 실패, 적용/Outbox 롤백, 응답 유실 후 재시도, 임의 PATCH 키, 온보딩, 교체·제거, 늦은 원격 쓰기·정리를 검증했다. 테스트 더블은 실제 바이트를 storage adapter로 읽고 복사하며, 서명 URL의 옵션/만료·생성 전용 조건을 검증한다.

실제 GCS V4 서명/IAM/CORS/업로드 URL 만료 강제, 브라우저 E2E, production 부하 및 원격 프로세스 강제 종료 실험은 미실행이다. 프로세스 종료 시의 durable checkpoint 복구는 DB 실패·원격 응답 유실 재현으로 검증했으며 실제 Pod kill 실험과 구분한다. Magic Bytes 검증은 완전한 디코딩/재인코딩/악성코드 검사가 아니다.

## 9. 실제 GCP 배포 전 작업

1. 기존 키의 객체 위치와 전용 버킷 이관 필요 여부를 확인한다. 기존 키를 일괄 무효화하지 않는다.
2. 검토된 environment의 프로젝트·namespace·webOrigins를 확인하고, 별도 승인된 운영 작업으로 전용 버킷/custom role/IAM/CORS/lifecycle을 준비한다. Post 권한이 그대로인지 확인한다.
3. Secret Manager의 고정 버전과 GKE ConfigMap에 활성화 설정이 충돌하지 않는지 확인한다. JSON key를 만들지 않는다. 로컬 서명 실험에는 서비스 계정 impersonation 가능한 ADC를 사용한다.
4. 새 migration을 기존 job으로 실행한 뒤 User/Gateway를 호환되는 버전으로 배포하고 통합 Swagger를 다시 수집한다. 구버전 Gateway는 새 경로를 허용하지 않는다.
5. 실제 frontend origin에서 JPEG/PNG/WebP 업로드, exact headers/Content-Length, 5분 후 PUT 실패, 중복 PUT 412, 실제 바이트 검증과 Signed GET, 양방향 차단을 E2E 확인한다. IAM 최소 권한으로 copy/get/delete/signBlob이 동작하는지 확인한다.
6. GCS 지연 시 Gateway timeout과 같은 uploadId complete 재시도를 확인하고, worker 정상 실행·오래된 이미지 유예·Pod 종료 복구·cleanup backlog를 관찰한다. 예시 코드의 오류 처리에 위 재시도 정책을 구현한다.

## 10. 최종 검증 기록·변경 파일

실행 환경은 Node 24.13.0/pnpm 10.33.0, 로컬 PostgreSQL 18 및 Redis 8이다. 새 업로드 migration과 실제 행 잠금/트랜잭션을 사용했다. 실제 Cloud SQL PostgreSQL 17에서의 실행은 배포 전 확인 대상이다.

| 검증 | 결과 |
| --- | --- |
| User `pnpm typecheck` | 통과 |
| User `RUN_GATEWAY_INTEGRATION=1 pnpm test` | **17개 파일, 293개 테스트 통과, 실패·skip 0** |
| User `pnpm build` | 통과 |
| HTTP Gateway `pnpm typecheck` / `pnpm build` | 모두 통과 |
| HTTP Gateway `RUN_INTEGRATION=1 pnpm test` | **5개 파일, 80개 테스트 통과, 실패·skip 0** |
| 기존 HTTP/WS 실제 로그인 토큰 + 새 이미지 Gateway→User 통합 | 위 User 전체 테스트에 포함, 통과 |
| `profile-image-gcp.test.mjs`, `gke.test.mjs`, `gke-storage.test.mjs` | 21개 통과 |
| 기존 `gcp-cicd-identity.test.mjs`, `gcp-config.test.mjs` | network none·read-only 마운트 Linux 컨테이너에서 4개 통과 |
| `gke-validate.mjs`, kubeconform 0.7.0 | 59개 리소스: 46 valid, invalid/error 0, 기존 CRD 제외 13 |
| 빌드된 실제 User OpenAPI + Gateway merge + SwaggerParser | 신규 경로 4개, Access JWT 요구·내부 헤더 제거 및 스키마 검증 통과 |
| 저장소 루트 `npm run format` | 통과. 무관한 파일 269개의 EOL 변경은 원본 byte로 복원 |
| 변경 코드 Prettier 검사 / `git diff --check` | 통과 |
| 독립 lint | 해당 두 package.json에 lint script 없음. strict TypeScript 및 Prettier로 검증 |
| 실제 GCS/브라우저/배포 E2E | 미실행. 완료로 주장하지 않음 |

초기 제한된 실행에서는 sandbox 테스트 워커/빌드가 정체되어 해당 작업 프로세스만 종료하고 정상 권한으로 재실행했다. 기존 POSIX gcloud mock 테스트 2개는 Windows에서 실패했으나, 네트워크가 없는 Linux 컨테이너에서 mock만 실행해 두 개 모두 통과했다. kubeconform 미설치는 CI와 같은 공식 버전의 Windows ZIP을 공개 SHA-256과 대조하여 해결했다. WS 선택형 통합 검증에 필요한 의존성/빌드만 로컬에 준비했으며 WS 소스·manifest·lockfile은 변경하지 않았다. 테스트의 의도적 DB 예외 로그는 롤백 주입 시나리오이며 최종 실패 테스트가 아니다.

변경 파일 목록(저장소 루트 기준):

```text
docs/contracts/frontend-integration.md
docs/deployment/gcp.md
gateways/http-gateway/src/user-auth.ts
gateways/http-gateway/test/user-auth.test.ts
scripts/gcp-bootstrap.mjs
scripts/gke-lib.mjs
scripts/profile-image-gcp.test.mjs
services/user-service/.env.example
services/user-service/README.md
services/user-service/PROFILE_IMAGE_GCS_IMPLEMENTATION_REPORT.md
services/user-service/package.json
services/user-service/pnpm-lock.yaml
services/user-service/src/config/configuration.ts
services/user-service/src/database/data-source.ts
services/user-service/src/database/entities/index.ts
services/user-service/src/database/entities/profile-image-upload.entity.ts
services/user-service/src/database/migrations/1793570000000-AddProfileImageUploads.ts
services/user-service/src/http-auth/gateway-auth.guard.ts
services/user-service/src/swagger.ts
services/user-service/src/users/users.controller.ts
services/user-service/src/users/users.module.ts
services/user-service/src/users/users.service.ts
services/user-service/src/users/profile-image/gcs-profile-image.storage.ts
services/user-service/src/users/profile-image/profile-image.config.ts
services/user-service/src/users/profile-image/profile-image.controller.ts
services/user-service/src/users/profile-image/profile-image.openapi.ts
services/user-service/src/users/profile-image/profile-image.service.ts
services/user-service/src/users/profile-image/profile-image.worker.ts
services/user-service/test/users.integration.test.ts
services/user-service/test/profile-image-config.test.ts
services/user-service/test/profile-image-storage.test.ts
services/user-service/test/profile-image.fake-gcs.ts
services/user-service/test/profile-image.integration.test.ts
```

실행 로그·로컬 formatter 백업·실제 통합 OpenAPI JSON은 저장소 밖의 WGO/.runtime에 두고 커밋하지 않는다. 새로 시작한 6381 테스트 전용 Redis는 검증 후 정리하며, 기존 User PostgreSQL/Redis 컨테이너·볼륨은 삭제하지 않는다.
