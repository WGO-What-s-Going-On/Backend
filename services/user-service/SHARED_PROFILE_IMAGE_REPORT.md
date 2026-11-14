# QA #12 — 공유 미디어 버킷 전환

2026-11-12, `fix/user-profile-image-qa`. 기준 작업 HEAD는 `542b929`다.
이번 범위는 코드·테스트·문서와 로컬 검증이다. 운영 IAM·Secret·버킷·배포와 Post 코드·기존 객체는 변경하지 않았다.

## 변경 내용

- `GCS_PROFILE_BUCKET`을 명시적으로 받는 기존 계약을 유지하고, Post 버킷과 같은 이름을 거부하는 규칙만 제거했다.
- `.env.example`은 기본 OFF를 유지하며 대상 버킷을 `project-103a7af1-0f7c-4697-972-wgo-demo-media`로 예시한다.
  GKE 렌더러도 `<project>-<namespace>-media`를 사용하므로 위 프로젝트에서 같은 값을 생성한다.
- 모든 업로드 서명·검증/복사·삭제는 UUID v4와 `user-profiles/pending/<UUID>`,
  `user-profiles/objects/<UUID>` 두 키의 정확한 일치를 먼저 검사한다.
  삭제는 임의 문자열 대신 업로드 이력과 pending/object 구분을 받으며 두 키 모두 검증한다.
  손상된 이력에 Post 키나 다른 UUID가 있으면 GCS 접근 전에 실패한다.
- 기존 MIME/크기/checksum/Magic Bytes, generation 조건, DB/Outbox 원자성, 완료 멱등성,
  교체·삭제·정리 유예는 유지한다. API 응답·DB schema·기존 사용자 키를 변경하지 않는다.
- 읽기는 기존 DB 키를 그대로 사용한다. 레거시 객체를 정리 대상으로 추가하거나 자동 이관하지 않는다.
  `user-profiles/` 안의 과거 비UUID 키도 읽기 계약을 유지하며 새 쓰기·삭제에는 허용하지 않는다.

Post는 `post-media/pending/media_<UUID>`, `post-media/objects/media_<UUID>`를 사용한다.
같은 UUID여도 두 서비스의 키 공간은 겹치지 않는다. User cleanup은 Post DB·객체 목록을 읽지 않는다.

## 승인된 외부 파일과 배포 동작

| 외부 파일                            | 변경                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `scripts/gke-lib.mjs`                | User 공유 버킷 렌더링, prefix 조건 생성과 직접/public IAM grant 검사                  |
| `scripts/gcp-bootstrap.mjs`          | profiles 버킷 생성 제거, 공유 버킷 조건부 User IAM, 사전 grant 검사와 role drift 거부 |
| `scripts/profile-image-gcp.test.mjs` | 실제 gcloud를 전부 대체한 bootstrap 분기·권한·기존 설정 보존 테스트                   |
| `docs/deployment/gcp.md`             | 공유 정책·운영 적용 전제 갱신                                                         |

기존 공유 버킷에는 CORS·lifecycle·versioning update를 하지 않는다. 새 버킷을 생성한 경우에만
기존 초기 CORS·versioning과 `user-profiles/pending/` 1일 삭제 규칙을 설정한다.
기존 버킷에 backstop이 필요하면 운영자가 현재 규칙을 보존하는 추가 변경을 별도로 검토해야 한다.
Post의 기존 IAM 명령은 유지하고, User를 위해 Post 권한이나 기존 객체를 수정하지 않는다.
CI/CD workflow와 Secret 버전·값은 수정하지 않았다.

User 내부 변경 파일은 아래 12개이며, 위 외부 4개와 합쳐 총 16개다.

```text
.env.example
README.md
PROFILE_IMAGE_GCS_IMPLEMENTATION_REPORT.md
QA12_PROFILE_IMAGE_VERIFICATION.md
SHARED_PROFILE_IMAGE_REPORT.md
src/users/profile-image/profile-image.config.ts
src/users/profile-image/gcs-profile-image.storage.ts
src/users/profile-image/profile-image.service.ts
test/profile-image-config.test.ts
test/profile-image-storage.test.ts
test/profile-image.fake-gcs.ts
test/profile-image.integration.test.ts
```

## IAM 검증과 한계

| 역할      | 필요한 권한·범위                                                    | 검증                                                        |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| 객체 접근 | `storage.objects.create/get/delete`, 공유 버킷의 `user-profiles/`만 | 키 guard 및 생성 계획·권한 실패 대역 테스트                 |
| URL 서명  | `iam.serviceAccounts.signBlob`, User GSA 자기 자신                  | 객체 권한과 독립적인 실패 대역·최소 role 생성 테스트        |
| 목록 조회 | 불필요. `storage.objects.list` 미부여                               | cleanup은 DB 이력의 정확한 키만 사용. 생성 role에 list 없음 |

객체 IAM 조건:

bootstrap 실행자의 운영 진단용 `storage.buckets.list`와 User 런타임의 `storage.objects.list`는 구분한다.

```text
resource.name.startsWith('projects/_/buckets/<shared-media-bucket>/objects/user-profiles/')
```

조건부 allow는 기존 broad allow를 제한하지 않는다. 실제 `--apply` 분기의 사전 검사에서는
User GSA 및 allUsers/allAuthenticatedUsers의 project·공유 bucket binding과 role 권한을 읽는다.
조건이 없거나 다른 조건, 넓은 storage 권한·list 권한, 조회 실패·타 프로젝트 custom role이면
자동 회수·덮어쓰기 대신 중단한다. 기존 profile custom role도 정확한 최소 권한과 다르면 바꾸지 않고 중단한다.
로컬 테스트는 broad/public/project grant, role drift와 조회 실패를 주입해 이 동작을 확인한다.

이 검사만으로 모든 유효 권한의 격리를 인증하지 않는다. 그룹 멤버십, 상위 folder/organization,
직접 KSA principal/principalSet grant, IAM deny/PAB까지는 별도 운영 분석이 필요하다.
배포 승인 전에는 Policy Troubleshooter 등으로 실제 User principal의 다음 결과를 확인한다.

- 프로필 객체 create/get/delete 허용, Post 객체 create/get/delete 및 bucket list 거부.
- 자기 GSA signBlob 허용. 객체 권한만으로 URL 서명이 된다고 판단하지 않는다.
- Signed URL 발급 성공만으로 GCS PUT/GET 권한이나 객체 존재가 검증됐다고 판단하지 않는다.

레거시 키가 `user-profiles/` 밖에 있으면 기존 읽기 API 호환성은 유지하더라도 제한된 IAM에서 실제 GET은
거부될 수 있다. 자동으로 권한을 넓히지 말고 객체 위치·소유권을 확인한 뒤 필요한 읽기 전용 예외나
별도 이관을 합의한다. 다른 버킷의 기존 객체를 이 변경이 이동시키지는 않는다.
Post의 기존 bucket-wide objectAdmin 권한은 유지하므로 이번 변경을 양방향 IAM 격리로 해석하지 않는다.

## 로컬 검증

환경은 Node 24.22.2, 이번 작업 전용 PostgreSQL 18·Redis 8과 GCS 바이트 대역이다.
실제 GCS IAM/CORS·브라우저·운영 업로드 E2E는 실행하지 않았다.

| 검증                                       | 결과                                     |
| ------------------------------------------ | ---------------------------------------- |
| User 전체 회귀, 분할 재검증 합산           | 29개 파일, 중복 제외 **541 통과·1 skip** |
| 최신 프로필 테스트 3개 + Outbox 재검증     | **75 통과**. 프로필 54개, Outbox 21개    |
| GKE/스토리지/공유 IAM/bootstrap 테스트     | **32 통과**                              |
| 기존 CD 테스트, Linux 로컬 컨테이너        | **27 통과**                              |
| User typecheck / build                     | 통과                                     |
| 변경 코드·신규 보고서 Prettier / diff 검사 | 통과                                     |
| User 외 6개 서비스의 생성 배포 리소스 비교 | 변경 없음                                |
| 실제 GCP IAM 적용·운영 E2E                 | 미실행, 승인 범위 밖                     |

첫 프로필 실행에서는 기존 Gateway 경유 2개가 5초 timeout을 넘겼고, 전체 실행은
539 통과·1 실패·1 skip이었다. 유일한 실패는 Outbox 테스트의 Nest HTTP adapter package 로딩이었다.
코드·timeout·의존성 버전 변경 없이 최종 프로필/Outbox 4개 파일을 다시 실행해 75개가 모두 통과했다.
최종 합산에는 전체 실행 뒤 추가한 레거시 키 테스트 1개를 포함하고 중복 실행분은 제외했다.
하나의 전체 실행이 처음부터 오류 없이 끝났다는 의미는 아니다.
skip 1개는 기존 opt-in Redis 재시작 테스트다.

Windows CD 실행은 `/dev/null` 출력 경로 때문에 2개가 실패했으나,
저장소를 read-only mount하고 운영 인증 없이 실행한 Linux 컨테이너에서 27개 모두 통과했다.
변경 코드만 범위를 지정해 포맷을 검사했다. 미변경 controller/openapi/worker의 기존 포맷 경고는
무관한 변경을 피하기 위해 그대로 두었다. User package.json에는 별도 lint script가 없다.

검증 범위:

- 공유 버킷 설정 허용, 잘못된 설정과 production credential/emulator 거부 유지.
- JPEG/PNG/WebP, 정상 및 위조·손상 바이트 검증, 멱등 완료·중복·수정/삭제 경합·장애 복구.
- Post 키, 다른 UUID, 경로 추가·순회 형태, 손상된 DB 이력의 쓰기·복사·삭제 차단.
- 동일 UUID의 Post 객체와 레거시 객체가 cleanup·교체·삭제 후에도 보존됨.
- signBlob 거부와 객체 접근 거부를 분리하고 서명 성공이 객체 접근을 보장하지 않음을 확인.
- gcloud 호출을 전부 가로채는 로컬 bootstrap 테스트. mock `--apply`는 실제 GCP 명령을 실행하지 않는다.

## 남은 운영 작업 — 이번에는 적용하지 않음

이전 읽기 전용 진단에서 실제 Post media 버킷과 WGO Origin의 GET/HEAD/PUT CORS, UBLA,
Public Access Prevention을 확인했다. User는 공유 버킷 binding이 없었고 실제 Pod의 signBlob 권한도 없었다.
기존 User 런타임은 `...-profiles`를 가리켰다. 이는 진단 당시 결과이며 이번 작업에서 재조회·변경하지 않았다.

1. 최종 유효 IAM을 검토한 뒤 User GSA의 prefix 조건부 객체 role과 자기 GSA signBlob role을 별도 승인으로 적용한다.
   객체 목록·버킷 관리·Post 객체 전체 접근권이나 광범위 TokenCreator를 추가하지 않는다.
2. User `GCS_PROFILE_BUCKET`을 실제 Post media 버킷으로 바꾸는 운영 설정 변경을 승인받는다.
   runtime Secret이 ConfigMap보다 우선하므로 오래된 Secret 값의 덮어쓰기를 확인한다.
3. CORS는 기존 Post origin·Range 등 헤더를 보존한다. 현재 필요한 규칙이 있으면 그대로 사용한다.
   pending lifecycle 추가가 필요하면 기존 전체 규칙을 덮어쓰지 않는다.
4. 코드 배포와 migration 상태를 확인하고 승인된 테스트 계정으로 PUT → complete → Signed GET 바이트,
   교체·삭제·새로고침·만료·응답 유실 재시도를 E2E 검증한다. 새 DB migration은 필요 없다.

QA #12는 코드·로컬 검증 완료와 운영 적용·E2E 완료를 구분해야 한다.
