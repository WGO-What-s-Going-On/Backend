# Post 이미지·동영상 / GCS 계약

이 계약은 Post Service만 변경한다. 게시물과 댓글 각각 이미지·동영상을 **합계 최대 5개** 첨부한다. 기존 텍스트 필수 조건, 댓글 참여·위치 검증은 그대로 유지한다. 본문 수정·첨부 교체 API, multipart 업로드, 리사이즈·썸네일·트랜스코딩·HLS는 포함하지 않는다. 단일 PUT으로 이미지 최대 기본 10MiB, 동영상 100MiB를 지원한다. MP4/WebM 컨테이너 허용이 모든 브라우저 코덱의 재생을 보장하지 않는다.

## 인증과 공개 범위

- 로컬/테스트 업로드 생성·상태·완료·취소는 기존 `X-User-Id` 양의 정수 정책이다. 다른 사용자 업로드는 404.
- **production 공개 업로드 및 기존 공개 작성 API는 사용자 인증 연동 전까지 503이다.** 이번 변경은 이를 우회하지 않는다. 운영 기능 활성화 완료로 간주하지 않는다.
- 조회 URL 발급은 기존 공개 조회 정책대로 ACTIVE 및 EXPIRED 게시물과 그 ACTIVE 댓글에 허용한다. 작성자 종료 또는 만료 시각 경과로 읽기를 차단하지 않으며 DELETED 게시물은 404다. 다른 비공개 접근 권한을 새로 정의하지 않는다.
- 내부 댓글 작성의 서비스 JWT/사용자 위임 검증을 유지한다. `mediaIds`는 추가 선택 필드다. 현재 WS Gateway는 이 필드를 전달하도록 변경하지 않았으므로 WS 첨부 작성은 별도 작업이다.
- Presigned URL은 소지자에게 유효한 임시 권한이다. URL/서명 헤더를 로그·이벤트·영구 DB·분석 도구에 기록하지 않는다. 이미 발급된 GET URL은 삭제 요청 즉시 취소되지 않으며 만료 또는 GCS 정리 시점까지 유효할 수 있다. 이미 받은 파일·브라우저 캐시는 회수할 수 없다.

## API와 프론트 흐름

기본 경로 `/api/v1/posts`. HTTP Gateway의 기존 Post 경로 전달을 사용하며 별도 Gateway 코드는 없다.

| Method / 경로 | 응답 | 의미 |
| --- | --- | --- |
| POST `/media/uploads` | 201 | 업로드 예약 및 PUT URL |
| GET `/media/uploads/:mediaId` | 200 | 본인 업로드 상태 |
| POST `/media/uploads/:mediaId/complete` | 200 | GCS 파일 검사, 보관 경로 복사, READY 전환 |
| DELETE `/media/uploads/:mediaId` | 204 | 미첨부 파일 취소, 비동기 삭제 예약 |
| GET `/:postId/media` | 200 배열 | 게시물 GET URL 새로 발급 |
| GET `/:postId/comments/:commentId/media` | 200 배열 | 댓글 GET URL 새로 발급 |

1. 파일의 SHA-256 **base64** digest를 계산한다. `POST /media/uploads`에 `{ "contentType": "image/png", "sizeBytes": 12345, "checksum": "<base64-sha256>" }`를 보낸다. 파일명·bucket·objectKey·소유자를 클라이언트가 지정할 수 없다. MIME 허용 목록: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/webm`; SVG/HTML은 금지한다.
2. 응답 `{ mediaId, status: "PENDING", attachmentExpiresAt, upload: { method: "PUT", url, headers, expiresAt } }`의 URL에 **원본 File/Blob 바이트**를 보낸다. FormData/multipart로 감싸지 않는다. `upload.headers` 그대로 사용하고 앱의 Authorization/Cookie를 GCS에 보내지 않는다. Content-Length도 서명 대상이다. 브라우저는 Blob의 크기로 자동 설정하며 JS에서 수동 설정하지 않는다. 비브라우저 클라이언트는 정확한 Content-Length가 필요하다.
3. GCS PUT 성공 후 complete 호출. HEAD 크기·Content-Type과 실제 파일 바이트 SHA256, 선두 8192바이트 파일 시그니처를 검사하고 서버 전용 최종 경로로 복사한다. 이는 전체 디코딩/악성코드 검사가 아니다. complete의 READY/ATTACHED 재호출은 멱등이다. 네트워크로 PUT 응답을 잃었다면 상태/complete로 확인한다. 동일 PUT 재시도는 x-goog-if-generation-match 때문에 412일 수 있다. URL 만료 후 미완료 업로드는 취소하고 새 예약을 만든다.
4. 기존 게시물 생성 body에 `mediaIds: ["media_<uuid>"]`를 추가한다. 댓글 생성은 `{ content, mediaIds }`. READY, 본인 소유, 예약 후 24시간 이내인 ID만 가능하며 한 파일은 한 게시물 또는 한 댓글에만 붙는다. ID 순서를 보존한다. 첨부 0개는 기존 동작이며 같은 ID 중복은 400.
5. 게시물 상세와 댓글 목록 응답에 `mediaIds`, `media` 배열이 추가된다. `media` 항목은 `{ mediaId, type: "IMAGE" | "VIDEO", contentType, sizeBytes, url, expiresAt }`. 생성 응답에는 mediaIds만 있고 URL은 조회로 받는다. `<img src={media.url}>` / `<video src={media.url} controls>`에 사용한다. URL 만료 전에 위 GET API를 다시 호출해 새 URL로 교체한다. 만료 후 Range 재요청이 실패하는 동영상도 갱신해야 한다. DB 파일은 URL 만료로 삭제되지 않는다.

예시(로컬 테스트):

```javascript
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
const checksum = btoa(String.fromCharCode(...digest));
const response = await fetch('/api/v1/posts/media/uploads', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': '123' },
  body: JSON.stringify({ contentType: file.type, sizeBytes: file.size, checksum }),
});
if (!response.ok) throw new Error('Upload reservation failed');
const { mediaId, upload } = await response.json();
const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: file, credentials: 'omit' });
if (!put.ok) throw new Error('GCS upload failed');
const complete = await fetch(`/api/v1/posts/media/uploads/${mediaId}/complete`, {
  method: 'POST', headers: { 'X-User-Id': '123' },
});
if (!complete.ok) throw new Error('Media verification failed');
// 이후 게시물/댓글 생성 body의 mediaIds에 mediaId를 넣는다.
```

400은 입력/개수/형식 오류, 403은 로컬 사용자 헤더 오류, 404는 없는 리소스/다른 소유자/삭제된 대상, 409는 첨부 불가능한 상태·이미 사용·만료, 422는 아직 없는 업로드 또는 파일 검증 실패, 503은 비활성 설정/서명·GCS 장애/운영 인증 미연동이다. 기존 Nest 오류 형식 `{statusCode,message,error}`를 사용한다. 첨부된 파일의 단독 취소는 409이며 게시물/댓글 삭제로 수명주기를 종료한다. 취소는 기록 정리 전까지 멱등, 정리 후는 404다. 내부 댓글 mutationId 재시도는 기존 결과 우선 정책을 유지한다.

## 데이터와 정리

- `posts.mediaIds`, `post_comments.mediaIds`: 순서 있는 ID 배열, 기존 문서는 미존재를 `[]`로 읽는다. 기존 데이터 backfill 불필요.
- 새 `post_media`: mediaId, ownerId, type, contentType, sizeBytes, SHA256 checksum, uploadKey, objectKey, 상태/시각, 연결된 postId/commentId. **URL을 저장하지 않는다.**
- 상태: PENDING → READY → ATTACHED. PENDING/READY 취소·24시간 만료, 대상 게시물 삭제·댓글 삭제 또는 부모 리소스 유실 시 DELETING → GCS 삭제 성공 후 DB 기록 제거.
- 이미 정리되어 ATTACHED 레코드가 없는 첨부는 상세·댓글 목록·첨부 URL 갱신 응답의 `media`에서 제외한다. 남은 첨부는 `mediaIds` 순서를 유지하며 모두 없으면 `media: []`를 반환한다. 저장된 `mediaIds`는 과거 참조로 남을 수 있다. 다른 게시물·댓글에 속한 첨부 참조는 계속 404로 차단하고 서명/GCS 장애는 숨기지 않는다. 기존 DELETING 작업은 복원하지 않으며 삭제된 파일을 되살리지 않는다.
- 첨부 READY→ATTACHED 조건부 변경과 게시물/댓글·counter·Outbox 기록은 **같은 MongoDB 트랜잭션**이다. 타인 파일·이미 첨부된 파일·동시 요청 실패는 전체 롤백한다. 파일 검증/복사는 트랜잭션 밖에서 한다. GCS와 MongoDB를 하나의 원자적 트랜잭션으로 처리하지 않는다.
- GCS pending 경로: `post-media/pending/<mediaId>`, 최종 경로: `post-media/objects/<mediaId>`. 업로드 서명은 pending에만 발급하고 x-goog-if-generation-match `0`로 덮어쓰기를 막는다. 검증한 generation 조건으로 final로 복사한다. 사용자 PUT URL 재사용이 첨부 파일을 바꾸지 못한다.
- Worker는 기본 60초마다 상태별 최대 50개를 처리한다. ATTACHED는 커서 순회로 삭제되거나 없어진 부모를 찾는다. 게시물 종료·만료만으로는 게시물과 ACTIVE 댓글의 첨부를 정리하지 않는다. 삭제 대상으로 바꾼 뒤 5분 유예하고 pending/final을 삭제한다. 실패 기록은 유지하고 5분 후 재시도한다. 다중 인스턴스 삭제는 같은 키에 대해 멱등이다. 대량 backlog는 여러 주기에 걸쳐 정리한다.
- pending prefix Lifecycle 만료를 **반드시** 설정한다. 완료 후 pending 원본, 늦은 업로드, URL 재사용으로 생긴 임시 객체를 정리한다. final prefix에는 광범위한 날짜 만료를 걸지 않는다. 비정상 장기 프로세스 정지·복구/DB 백업 복원 후에는 GCS inventory와 DB objectKey를 대조해 orphan을 점검한다.
- 기존 Redis 이벤트 payload/버전은 변경하지 않는다. WS/이벤트로 갱신을 인지한 소비자는 Post API에서 첨부를 조회한다. 이벤트에 URL이나 objectKey를 싣지 않는다.

## 환경과 권한

`GCS_MEDIA_ENABLED=true`와 `GCS_MEDIA_BUCKET`을 설정한다. 버킷은 private이며 uniform bucket-level access와 public access prevention을 사용한다.
`GCS_MEDIA_UPLOAD_TTL_SECONDS`는 기본 300초, 5~900초를 허용한다. `GCS_MEDIA_READ_TTL_SECONDS`는 기본 3600초, 5~3600초를 허용한다.

읽기 URL은 TTL의 절반(초 단위 내림) 구간마다 서명 시작·만료를 함께 고정한다. 기본 설정에서는 같은 30분 구간의 같은 객체·서명 계정은 동일 URL이며, 반환 시 30~60분의 유효시간이 남는다. `expiresAt`이 실제 만료 기준이다. 캐시는 `private, max-age=86400`으로 설정한다. 프론트는 mediaId별 URL을 expiresAt까지 재사용할 수 있다. 이미 다운로드한 캐시는 URL 만료나 게시물 삭제 이후에도 남을 수 있다.
`GCS_MEDIA_IMAGE_MAX_BYTES`는 기본 10 MiB, 최대 20 MiB다. `GCS_MEDIA_VIDEO_MAX_BYTES`는 기본·최대 100 MiB다.
`GCS_MEDIA_CLEANUP_INTERVAL_MS`는 기본 60000이다. 미디어 비활성화는 기존 첨부 조회도 중단하므로 rollback 수단으로 쓰지 않는다.

Post Pod는 Workload Identity와 ADC로 인증한다. GSA에는 해당 버킷 객체의 읽기·생성·삭제 권한을 부여한다. V4 URL 서명을 위해 서명 GSA에 대한 `iam.serviceAccounts.signBlob` 권한도 부여하고 IAM Credentials API를 활성화한다. production에서는 `GOOGLE_APPLICATION_CREDENTIALS`와 `STORAGE_EMULATOR_HOST`를 거부한다. 사용자 업로드는 pending 경로에만 서명한다.

GCS CORS에는 실제 프런트 origin만 허용하고 PUT, GET, HEAD와 `Content-Type`, `Content-Length`, `x-goog-if-generation-match`, `Range`를 설정한다. 브라우저가 전달하는 응답 `headers`를 그대로 사용한다. 앱 인증 헤더를 GCS에 전달하지 않는다.

pending prefix에는 2일 Lifecycle 만료를 둔다. final prefix에는 무조건 날짜 만료를 두지 않는다. 이 서비스의 삭제는 live object를 대상으로 한다. 버전 보존과 soft delete를 켜는 경우 보존 기간과 개인정보 삭제 정책을 별도로 정하고 noncurrent 객체도 수명주기로 정리한다. DB 복원 후에는 objectKey와 버킷 inventory를 비교한다.

## GCS 검증과 재시도

업로드는 `x-goog-if-generation-match: 0`을 서명하여 기존 객체를 덮어쓰지 못하게 한다. complete는 크기와 Content-Type을 확인한 뒤 정확한 generation의 바이트를 읽는다. 파일 전체 SHA-256과 길이를 검증하고 선두 8192바이트에서 MIME signature를 확인한다. 최대 선언 크기까지만 읽고 15초 timeout을 적용한다. metadata에 기록된 사용자 checksum은 신뢰하지 않는다.

복사는 같은 source generation과 destination `ifGenerationMatch=0`을 사용한다. copy 성공 후 응답 유실이나 동시 complete가 412를 받으면 final 객체의 실제 바이트를 다시 검증한다. pending을 다시 업로드하더라도 final을 덮어쓸 수 없다. SHA 검증은 전체 바이트 읽기 비용을 발생시키지만 메모리에는 해시 상태와 8 KiB 헤더만 유지한다.

## 검증 범위

`pnpm test`는 실제 SDK URL 생성에 서명 응답을 대체하여 서명 헤더를 검사하고, GCS 응답을 대체해 generation·바이트 checksum·MIME·copy 재시도·삭제 동작을 확인한다. `RUN_INTEGRATION=1 pnpm test`의 media suite는 실제 MongoDB replica set을 사용하며 GCS adapter는 대체한다.

실제 버킷과 GKE Workload Identity는 별도 검증이 필요하다. `GCS_MEDIA_ENABLED=true GCS_MEDIA_BUCKET=<bucket> pnpm media:gcs:smoke`는 임시 PNG 업로드·complete 검증·서명 다운로드·삭제를 수행한다. 이 명령은 GCS에 쓰고 테스트 객체를 삭제한다. 브라우저 CORS, URL 만료, 잘못된 generation, signBlob 권한 거부는 staging에서 추가 검증한다.

- [GCS request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
- [GCS signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)
