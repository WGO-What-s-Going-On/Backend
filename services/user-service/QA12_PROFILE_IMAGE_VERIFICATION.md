# QA #12 — 프로필 이미지 로컬 검증 보고

검증일: 2026-11-11 (Asia/Seoul).

2026-11-12 정책 갱신: Post의 기존 media 버킷을 공유한다. 아래 테스트 수치는 11월 11일 이력이며, 현재 수정 및 운영 진단 결과는 [공유 버킷 변경 보고](SHARED_PROFILE_IMAGE_REPORT.md)를 따른다.

## 1. 결론과 작업 범위

최신 `origin/dev`의 기존 프로필 이미지 구현을 검증했다. **로컬 PostgreSQL과 GCS 테스트 대역으로
실행한 업로드·완료·조회·교체·삭제 흐름에서는 기능 버그를 재현하지 못했다.**
실제 GCS와 브라우저·운영환경의 실패 원인까지 확인했다는 뜻은 아니며, QA #12의 운영 해결 완료로 판단하지 않는다.
재현 근거 없이 런타임 코드를 바꾸거나 기능을 중복 개발하지 않았다.

- 시작 브랜치: `chore/qa12-profile-image-verification`. 미커밋 변경사항 없음.
- `git fetch origin dev` 후 기준: `247f3634450f83e5607cacc4d42b5e7e5aeeedb9`.
- 작업 브랜치: `fix/user-profile-image-qa`. 새로 생성했으며 dev·기존 브랜치에 커밋하지 않는다.
- 변경 범위: 이 보고서와 User README 링크만. API·DB schema·이벤트·기존 이미지 키는 변경하지 않는다.
- GCP/GKE 접속, 운영 DB/GCS/IAM/Secret 확인·변경, 배포, 실제 사용자 데이터 변경은 실행하지 않았다.
- 로컬 테스트용 별도 PostgreSQL·Redis를 사용했다. 기존 컨테이너·볼륨을 시작하거나 초기화하지 않았다.
- push, PR, merge는 실행하지 않는다.

## 2. 확인한 기존 구현

| 단계           | 현재 구현 및 확인점                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| URL 발급       | ACTIVE 사용자 확인 → 서버 UUID/임시·최종 키와 PENDING 이력 저장 → V4 PUT 서명. 서명 응답 유실에도 정리할 이력을 남김    |
| 직접 업로드    | 클라이언트가 GCS에 원본 바이트 PUT. Content-Type·정확한 길이·생성 전용 조건을 서명에 결합                               |
| 파일 검증      | metadata 크기/MIME, 실제 길이·SHA-256·Magic Bytes 확인. 같은 GCS generation을 읽고 생성 전용 최종 객체로 복사           |
| 완료·DB 반영   | owner → upload 잠금 순서 유지. VERIFIED 저장 후 사용자 키·APPLIED·필요한 Outbox를 별도 트랜잭션에서 원자 반영           |
| 조회           | 본인 또는 접근 가능한 타인에 대해 V4 Signed GET 발급. 타인 조회는 ACTIVE·온보딩 완료·양방향 미차단 필요                 |
| 교체·삭제      | 새 업로드 완료로 교체. `PATCH /api/v1/users/me`의 `profileImageKey: null`로 참조 제거. 물리 객체는 worker가 나중에 정리 |
| 중복·장애 복구 | 같은 uploadId 완료 요청은 멱등. 이미 교체·삭제한 옛 업로드 재요청은 원래 사진을 복원하지 않음                           |
| 인증           | 공개 클라이언트의 Access JWT를 Gateway가 검증하고 User에는 ES256 서비스 JWT와 내부 사용자 문맥 전달                     |

주요 구현은 [ProfileImageService](src/users/profile-image/profile-image.service.ts),
[GCS adapter](src/users/profile-image/gcs-profile-image.storage.ts),
[Controller](src/users/profile-image/profile-image.controller.ts),
[정리 worker](src/users/profile-image/profile-image.worker.ts)에 있다.

허용 MIME은 JPEG/PNG/WebP, 크기는 1~2,097,152 bytes다.
PUT·GET URL은 300초이며, 미적용 업로드의 완료 가능 기한도 발급 후 300초다.
Magic Bytes 검사는 완전한 이미지 디코딩·재인코딩이나 악성코드 검사를 의미하지 않는다.

## 3. 로컬 검증 결과

환경: Windows, Node.js 24.22.2, 전용 PostgreSQL 18·Redis 8.
PostgreSQL은 loopback 15432, Redis는 기존 테스트의 고정 주소에 맞춘 loopback 6379를 사용했다.
기존 테스트의 DB 초기화는 이 작업에서 새로 만든 Redis 컨테이너 안에서만 수행했다.
GCS 테스트 대역은 파일 바이트·metadata·복사·삭제·장애를 흉내 내며 **실제 IAM·CORS·원격 서명 검증은 하지 않는다.**

| 항목                                                       | 결과                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 프로필 이미지 기존 테스트 3개 파일                         | 37 통과, Gateway 선택 테스트 1개 skip. 이후 전체 실행에서 선택 테스트 활성화                                             |
| User 전체 회귀 + HTTP/WS Gateway 선택 통합                 | 분할 재검증 합산 **29개 파일, 525 통과, Redis 재시작 선택 테스트 1개 skip**. 아래 실행 기록 참조                         |
| 기존 migration 전체를 전용 로컬 DB에 적용                  | 9개 적용, pending 없음, `profile_image_uploads` 생성 확인                                                                |
| User 타입 검사·빌드                                        | 통과                                                                                                                     |
| 실제 생성한 User OpenAPI + Gateway 병합·SwaggerParser      | 업로드/완료/본인 조회/타인 조회/삭제 PATCH 5개 operation 통과. 공개 Access JWT·외부 x-user-id 미노출·null 전용 삭제 확인 |
| 저장소의 GCP 프로필·GKE 설정 테스트                        | 26 통과. manifest 생성·bootstrap dry-run 검사이며 실제 GCP 호출 없음                                                     |
| 신규 보고서 Prettier·문서 링크·JSON 예시·diff 검사         | 통과. README의 기존 포맷 차이는 유지                                                                                     |
| 실제 Cloud SQL PostgreSQL 17·GCS PUT/GET·브라우저·운영 E2E | 미실행. 이번 작업의 운영 접근 금지 범위                                                                                  |
| 독립 lint                                                  | User package.json에 별도 lint script 없음                                                                                |

전체 기본 병렬 실행에서는 484 통과·9 실패·1 skip 및 import 단계 suite 실패 3개가 발생했다.
`EBUSY` 파일 잠금, 테스트 시간 초과와 그 뒤 assertion/DB deadlock이 관찰됐다.
이를 프로필 기능의 결함으로 단정하지 않고 코드·시간 제한을 바꾸지 않은 단일 worker 실행으로 재확인했다.

단일 worker 실행은 기능 테스트 418개가 통과했으나, 3개 파일에서 다시 의존성 import 파일 잠금이 발생했다.
그 중 `database-cloud-sql.test.ts`·`rewards.integration.test.ts`를 재실행해 81 통과·재시작 선택 테스트 1 skip,
마지막 `gateway-auth.test.ts`를 단독 실행해 26 통과를 확인했다.
따라서 **29개 파일을 분할 재검증한 합산은 525 통과·1 skip**이며, 하나의 전체 실행이 오류 없이 끝났다고 주장하지 않는다.
남은 skip은 `USER_REWARDS_RESTART_CONTAINER` 미설정에 따른 기존 Redis 재시작 선택 테스트다.
Gateway 경유 프로필 이미지 테스트를 포함한 프로필 이미지 3개 파일의 38개 테스트는 모두 통과했다.
이 과정에서 테스트 코드·timeout·의존성 버전은 바꾸지 않았다.

검증 시나리오:

- PNG 업로드 → 실제 adapter 바이트 검증/복사 → DB 프로필 반영 → 본인·타인 URL 발급 → 교체 → 삭제.
- JPEG/PNG/WebP signature 판별과 크기·MIME·checksum·Magic Bytes 불일치 거부.
- 미인증·헤더 위조·타인 업로드 완료·존재하지 않는 업로드·비활성 계정·양방향 차단.
- PENDING/VERIFIED 만료 거부, 동일·서로 다른 uploadId의 동시 완료, 교체/삭제 후 과거 완료 재요청.
- GCS 장애, 복사는 성공했으나 응답 유실, VERIFIED 저장 실패, 사용자 키·Outbox 트랜잭션 rollback 및 재시도.
- 임의 문자열 이미지 키 PATCH 거부, 온보딩 상태 보존, 참조 중 객체 보존과 유예 후 정리.
- 로컬 HTTP Gateway → User의 실제 Access/서비스 JWT 경로 및 User Swagger 계약.

재실행은 User 디렉터리에서 위 전용 로컬 DB 설정을 적용한 뒤
`RUN_GATEWAY_INTEGRATION=1 RUN_REWARDS_GATEWAY_INTEGRATION=1 pnpm test --maxWorkers=1`을 사용한다.
PowerShell에서는 앞의 두 변수를 `$env:...='1'` 형식으로 지정한다.
선택 테스트는 최신 HTTP/WS Gateway의 로컬 빌드 산출물이 필요하다. 두 Gateway의 소스는 수정하지 않았다.
원래 테스트에 고정 Redis 주소와 초기화가 있으므로 **운영·개발 데이터가 있는 Redis에서 실행하지 않는다.**

## 4. FE 전달용 API 계약

모든 WGO 요청은 Gateway를 통해 보내고 `Authorization: Bearer <Access JWT>`를 사용한다.
`x-user-id`를 직접 넣지 않는다. 별도 `DELETE /profile-image` API는 없다.

| 순서 | 요청                                                              | 응답·주의사항                                                             |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | `POST /api/v1/users/me/profile-image/uploads`                     | 201. 아래 요청으로 uploadId/uploadUrl/method/headers/expiresAt 수신       |
| 2    | 응답 uploadUrl에 `PUT`                                            | 응답 headers와 원본 File/Blob만 전송. WGO 토큰·FormData를 보내지 않음     |
| 3    | `POST /api/v1/users/me/profile-image/uploads/{uploadId}/complete` | 200. uploadId/status/profileImageKey/isCurrent. PUT 성공 후 호출          |
| 4    | `GET /api/v1/users/me`                                            | 현재 profileImageKey 재조회. complete 응답의 과거 키로 UI를 덮어쓰지 않음 |
| 5    | `GET /api/v1/users/me/profile-image/url`                          | profileImageKey/url/expiresAt. 실제 이미지 src는 url 사용                 |
| 타인 | `GET /api/v1/users/{userId}/profile-image/url`                    | 같은 응답. 접근 불가·차단·미존재는 404                                    |
| 삭제 | `PATCH /api/v1/users/me` + `{"profileImageKey":null}`             | 참조 제거 후 본인 프로필·URL 재조회. GCS 직접 DELETE 금지                 |

발급 요청 예시:

```json
{
  "contentType": "image/png",
  "sizeBytes": 68,
  "checksum": "<선택한 실제 파일 바이트의 SHA-256 Base64>"
}
```

`sizeBytes`는 예시값이다. 실제로는 `file.size`, `contentType`은 허용된 실제 MIME을 사용한다.
checksum은 hex나 파일 전체의 Base64가 아니라 **SHA-256 32바이트의 Base64(44자)**다.

```js
const digest = new Uint8Array(
  await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
);
const checksum = btoa(String.fromCharCode(...digest));
// WGO API 클라이언트로 위 요청을 보내 발급받은 upload 사용
const put = await fetch(upload.uploadUrl, {
  method: upload.method,
  headers: upload.headers,
  body: file,
  credentials: 'omit',
});
if (!put.ok) throw new Error(`GCS PUT ${put.status}`);
// 같은 upload.uploadId로 WGO complete 호출 후 현재 프로필과 URL을 다시 조회
```

브라우저는 File/Blob 길이에서 Content-Length를 자동 설정한다. 수동 설정하지 않는다.
비브라우저 클라이언트는 발급 시 선언한 정확한 Content-Length가 필요하다.
전체 연동 함수·응답 예시는 [기존 인계 문서의 API 계약](PROFILE_IMAGE_GCS_IMPLEMENTATION_REPORT.md#4-api프론트엔드-연동-계약)을 따른다.

FE의 실패·재시도 처리:

- 업로드·완료 기한이 지난 미적용 요청은 409: 새 uploadId를 발급받아 다시 전송한다.
- GCS PUT 응답 유실 후 412: 같은 uploadId의 complete로 검증을 시도한다. 무조건 새 이미지를 만들지 않는다.
- complete 응답 유실·502/504/503: 서버는 적용했을 수 있으므로 같은 uploadId로 제한된 backoff 재시도하고 현재 프로필을 조회한다.
- 422: 미완료 PUT 또는 바이트/MIME/크기/checksum 불일치다. 실제 원인을 확인하고 불일치는 새 업로드로 시작한다.
- `isCurrent:false`: 과거에 적용됐지만 현재 사진은 다른 이미지이거나 삭제된 상태다. 옛 사진으로 되돌리지 않는다.
- URL 만료로 GCS 이미지 GET이 403이면 WGO URL API에서 새 URL을 받아 다시 표시한다. 무한 재시도하지 않는다.
- 이미지가 없으면 `{profileImageKey:null,url:null,expiresAt:null}`이며 기본 아바타를 표시한다.
- URL 조회 404는 접근 불가로 처리하고 기존 이미지를 지운다. Signed URL·응답·JWT를 콘솔/분석 로그·영속 캐시에 저장하지 않는다.

## 5. 운영 추가 확인 체크리스트 — 이번에는 실행하지 않음

저장소에 설정 생성 코드가 있다는 사실과 운영에 적용됐다는 사실은 다르다.
아래는 별도 승인된 후속 작업에서 확인할 항목이다.

- [ ] 실행 중인 User/Gateway 이미지 SHA와 공개 API 경로가 이번에 확인한 dev 계약을 포함하는가.
- [ ] User의 최종 런타임 설정이 `GCS_PROFILE_ENABLED=true`, `GCS_PROFILE_BUCKET=<project>-<namespace>-media`인가.
      ConfigMap과 runtime Secret 간 우선순위·이전 값 덮어쓰기도 확인한다. 로컬 기본값은 false다.
- [ ] Post가 실제 사용하는 비공개 media 버킷과 일치하고 객체 prefix는 분리됐는가.
      UBLA/public-access-prevention, pending prefix 수명주기를 확인한다. final 객체에 일괄 age 삭제를 걸지 않는다.
- [ ] User KSA↔GSA Workload Identity/ADC와 `iamcredentials.googleapis.com`이 준비됐는가.
      `user-profiles/`로 제한된 create/get/delete 및 자기 GSA의 signBlob 권한이 각각 있는가. 기존 넓은 grant·그룹/상위 상속·직접 KSA 권한도 검토한다.
      JSON key·production emulator·User에 대한 Post 객체 전체 권한으로 우회하지 않는다.
- [ ] GCS CORS가 실제 FE origin의 GET/HEAD/PUT과 필요한 Content-Type·generation 조건을 지원하는가.
      Gateway CORS와 GCS CORS는 별개다. curl PUT 성공만으로 브라우저 CORS 통과를 판단하지 않는다.
- [ ] 운영 DB migration 이력에 `AddProfileImageUploads1793570000000`이 있고 테이블·제약·인덱스가 존재하는가.
      앱은 `synchronize:false`이므로 실행 중인 Pod만으로 migration 적용을 추정하지 않는다.
- [ ] 기존 `users.profile_image_key`의 객체가 현재 공유 버킷과 권한 범위에서 실제 조회 가능한가.
      기존 키는 호환 보존하지만 자동 이관하지 않으며, 다른 버킷의 레거시 객체 문제는 별도 이관 판단이 필요하다.
- [ ] 승인된 테스트 계정·이미지로 실제 FE origin에서 JPEG/PNG/WebP PUT → complete → DB 참조 → Signed GET 바이트를 확인한다.
      URL 발급 성공만 확인하지 말고 이미지 HTTP 응답과 바이트까지 확인한다.
- [ ] 실제 5분 만료, PUT 중복/실패, 잘못된 바이트, 교체·삭제·차단, GCS 장애·complete 응답 유실을 확인한다.
- [ ] 공개 Gateway의 5초 기본 upstream timeout과 최대 수십 초의 GCS 검증 지연을 고려해 같은 uploadId 재시도를 확인한다.
      timeout 정합성 변경이 필요하면 Gateway 담당 후속 작업으로 처리한다.
- [ ] cleanup worker와 실패 재시도·cleanup backlog, 비참조 이미지 유예 후 정리를 확인한다.
      프로필 삭제는 즉시 DB 참조를 제거하지만 물리 객체 삭제는 비동기다.

`GET /health/ready`는 DB `SELECT 1` 확인이며 GCS 권한·서명·객체 존재를 검사하지 않는다.
Signed GET 발급도 객체 존재를 먼저 검사하지 않으므로 API 200만으로 이미지가 실제 표시된다고 판단하지 않는다.
이미 발급된 URL은 차단·삭제 이후에도 만료 전까지 사용 가능할 수 있다.

## 6. 남은 문제와 팀 후속 작업

- **QA #12의 실제 서비스 원인은 미확정**이다. 승인된 운영 검증에서 실패 단계·HTTP 상태·requestId/uploadId를 수집해야 한다.
  Signed URL 전체·JWT·사용자 이미지 원문은 로그나 이슈에 붙이지 않는다.
- FE: 이 문서의 발급 → raw PUT → complete → 현재 프로필/URL 재조회, 만료·재시도·기본 아바타 처리를 연결한다.
  이 저장소에는 FE 구현이 없어 실제 화면 연동 완료를 확인하지 않았다.
- 운영 담당: 위 버킷/IAM/CORS/런타임 설정/migration/레거시 객체 체크리스트와 실제 브라우저 E2E를 수행한다.
- Gateway 담당: 실행 버전의 인증 allowlist·라우팅·통합 Swagger 포함 여부와 timeout 동작을 확인한다.
  로컬에서는 기존 구현이 동작했으며 이 작업에서 Gateway 코드를 수정하지 않았다.
- 실제 URL 즉시 회수·물리 이미지 즉시 삭제·레거시 객체 이관 등은 현재 계약에 없는 추가 요구다.
  이번 QA에서 임의로 API나 다른 서비스의 동작을 바꾸지 않았다.
