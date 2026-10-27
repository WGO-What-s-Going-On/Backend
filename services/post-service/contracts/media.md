# Post 이미지·동영상 / S3 계약

이 계약은 Post Service만 변경한다. 게시물과 댓글 각각 이미지·동영상을 **합계 최대 5개** 첨부한다. 기존 텍스트 필수 조건, 댓글 참여·위치 검증은 그대로 유지한다. 본문 수정·첨부 교체 API, multipart 업로드, 리사이즈·썸네일·트랜스코딩·HLS는 포함하지 않는다. 단일 PUT으로 이미지 최대 기본 10MiB, 동영상 100MiB를 지원한다. MP4/WebM 컨테이너 허용이 모든 브라우저 코덱의 재생을 보장하지 않는다.

## 인증과 공개 범위

- 로컬/테스트 업로드 생성·상태·완료·취소는 기존 `X-User-Id` 양의 정수 정책이다. 다른 사용자 업로드는 404.
- **production 공개 업로드 및 기존 공개 작성 API는 사용자 인증 연동 전까지 503이다.** 이번 변경은 이를 우회하지 않는다. 운영 기능 활성화 완료로 간주하지 않는다.
- 조회 URL 발급은 기존 공개 조회 정책대로 ACTIVE이고 기한이 지나지 않은 게시물, ACTIVE 댓글에만 허용한다. 다른 비공개 접근 권한을 새로 정의하지 않는다.
- 내부 댓글 작성의 서비스 JWT/사용자 위임 검증을 유지한다. `mediaIds`는 추가 선택 필드다. 현재 WS Gateway는 이 필드를 전달하도록 변경하지 않았으므로 WS 첨부 작성은 별도 작업이다.
- Presigned URL은 소지자에게 유효한 임시 권한이다. URL/서명 헤더를 로그·이벤트·영구 DB·분석 도구에 기록하지 않는다. 이미 발급된 GET URL은 삭제 요청 즉시 취소되지 않으며 만료 또는 S3 정리 시점까지 유효할 수 있다. 이미 받은 파일·브라우저 캐시는 회수할 수 없다.

## API와 프론트 흐름

기본 경로 `/api/v1/posts`. HTTP Gateway의 기존 Post 경로 전달을 사용하며 별도 Gateway 코드는 없다.

| Method / 경로 | 응답 | 의미 |
| --- | --- | --- |
| POST `/media/uploads` | 201 | 업로드 예약 및 PUT URL |
| GET `/media/uploads/:mediaId` | 200 | 본인 업로드 상태 |
| POST `/media/uploads/:mediaId/complete` | 200 | S3 파일 검사, 보관 경로 복사, READY 전환 |
| DELETE `/media/uploads/:mediaId` | 204 | 미첨부 파일 취소, 비동기 삭제 예약 |
| GET `/:postId/media` | 200 배열 | 게시물 GET URL 새로 발급 |
| GET `/:postId/comments/:commentId/media` | 200 배열 | 댓글 GET URL 새로 발급 |

1. 파일의 SHA-256 **base64** digest를 계산한다. `POST /media/uploads`에 `{ "contentType": "image/png", "sizeBytes": 12345, "checksum": "<base64-sha256>" }`를 보낸다. 파일명·bucket·objectKey·소유자를 클라이언트가 지정할 수 없다. MIME 허용 목록: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/webm`; SVG/HTML은 금지한다.
2. 응답 `{ mediaId, status: "PENDING", attachmentExpiresAt, upload: { method: "PUT", url, headers, expiresAt } }`의 URL에 **원본 File/Blob 바이트**를 보낸다. FormData/multipart로 감싸지 않는다. `upload.headers` 그대로 사용하고 앱의 Authorization/Cookie를 S3에 보내지 않는다. Content-Length도 서명 대상이다. 브라우저는 Blob의 크기로 자동 설정하며 JS에서 수동 설정하지 않는다. 비브라우저 클라이언트는 정확한 Content-Length가 필요하다.
3. S3 PUT 성공 후 complete 호출. HEAD 크기·Content-Type·SHA256, 선두 8192바이트 파일 시그니처를 검사하고 서버 전용 최종 경로로 복사한다. 이는 전체 디코딩/악성코드 검사가 아니다. complete의 READY/ATTACHED 재호출은 멱등이다. 네트워크로 PUT 응답을 잃었다면 상태/complete로 확인한다. 동일 PUT 재시도는 If-None-Match 때문에 412일 수 있다. URL 만료 후 미완료 업로드는 취소하고 새 예약을 만든다.
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
if (!put.ok) throw new Error('S3 upload failed');
const complete = await fetch(`/api/v1/posts/media/uploads/${mediaId}/complete`, {
  method: 'POST', headers: { 'X-User-Id': '123' },
});
if (!complete.ok) throw new Error('Media verification failed');
// 이후 게시물/댓글 생성 body의 mediaIds에 mediaId를 넣는다.
```

400은 입력/개수/형식 오류, 403은 로컬 사용자 헤더 오류, 404는 없는 리소스/다른 소유자/비활성 대상, 409는 첨부 불가능한 상태·이미 사용·만료, 422는 아직 없는 업로드 또는 파일 검증 실패, 503은 비활성 설정/서명·S3 장애/운영 인증 미연동이다. 기존 Nest 오류 형식 `{statusCode,message,error}`를 사용한다. 첨부된 파일의 단독 취소는 409이며 게시물/댓글 삭제로 수명주기를 종료한다. 취소는 기록 정리 전까지 멱등, 정리 후는 404다. 내부 댓글 mutationId 재시도는 기존 결과 우선 정책을 유지한다.

## 데이터와 정리

- `posts.mediaIds`, `post_comments.mediaIds`: 순서 있는 ID 배열, 기존 문서는 미존재를 `[]`로 읽는다. 기존 데이터 backfill 불필요.
- 새 `post_media`: mediaId, ownerId, type, contentType, sizeBytes, SHA256 checksum, uploadKey, objectKey, 상태/시각, 연결된 postId/commentId. **URL을 저장하지 않는다.**
- 상태: PENDING → READY → ATTACHED. PENDING/READY 취소·24시간 만료, 대상 게시물 만료/삭제·댓글 삭제 시 DELETING → S3 삭제 성공 후 DB 기록 제거.
- 첨부 READY→ATTACHED 조건부 변경과 게시물/댓글·counter·Outbox 기록은 **같은 MongoDB 트랜잭션**이다. 타인 파일·이미 첨부된 파일·동시 요청 실패는 전체 롤백한다. 파일 검증/복사는 트랜잭션 밖에서 한다. S3와 MongoDB를 하나의 원자적 트랜잭션으로 처리하지 않는다.
- S3 pending 경로: `post-media/pending/<mediaId>`, 최종 경로: `post-media/objects/<mediaId>`. 업로드 서명은 pending에만 발급하고 If-None-Match `*`로 덮어쓰기를 막는다. 검증한 ETag 조건으로 final로 복사한다. 사용자 PUT URL 재사용이 첨부 파일을 바꾸지 못한다.
- Worker는 기본 60초마다 상태별 최대 50개를 처리한다. ATTACHED는 커서 순회로 종료된 부모를 찾는다. 삭제 대상으로 바꾼 뒤 5분 유예하고 pending/final을 삭제한다. 실패 기록은 유지하고 5분 후 재시도한다. 다중 인스턴스 삭제는 같은 키에 대해 멱등이다. 대량 backlog는 여러 주기에 걸쳐 정리한다.
- pending prefix Lifecycle 만료를 **반드시** 설정한다. 완료 후 pending 원본, 늦은 업로드, URL 재사용으로 생긴 임시 객체를 정리한다. final prefix에는 광범위한 날짜 만료를 걸지 않는다. 비정상 장기 프로세스 정지·복구/DB 백업 복원 후에는 S3 inventory와 DB objectKey를 대조해 orphan을 점검한다.
- 기존 Redis 이벤트 payload/버전은 변경하지 않는다. WS/이벤트로 갱신을 인지한 소비자는 Post API에서 첨부를 조회한다. 이벤트에 URL이나 objectKey를 싣지 않는다.

## 환경변수

| 변수 | 필수/기본값 | 로컬과 운영 |
| --- | --- | --- |
| S3_MEDIA_ENABLED | 선택, false | true일 때만 S3 기능과 정리 Worker 활성화. 기존 무파일 로컬 동작 유지 |
| AWS_REGION | enabled이면 필수 | 예: ap-northeast-2; bucket 리전과 일치 |
| S3_MEDIA_BUCKET | enabled이면 필수, 기본 없음 | 이름만, URL/ARN 아님. 전용 private general purpose bucket |
| S3_MEDIA_ENDPOINT | 선택, 기본 없음 | 로컬 S3 호환 도구용 HTTP(S) URL; 운영 금지. 브라우저와 Post 양쪽에서 접근 가능해야 함 |
| S3_MEDIA_UPLOAD_TTL_SECONDS | 선택, 300; 5~900 | PUT URL 요청 유효시간; 임시 자격 증명 만료에 맞춰 단축 |
| S3_MEDIA_READ_TTL_SECONDS | 선택, 300; 5~900 | GET URL 요청 유효시간; 임시 자격 증명 만료에 맞춰 단축 |
| S3_MEDIA_IMAGE_MAX_BYTES | 선택, 10485760; 1~20971520 | 이미지 업로드 크기 상한 |
| S3_MEDIA_VIDEO_MAX_BYTES | 선택, 104857600; 1~104857600 | 동영상 업로드 크기 상한 |
| S3_MEDIA_CLEANUP_INTERVAL_MS | 선택, 60000; 1~3600000 | 정리 주기; 기본값 사용 권장 |

TTL은 5~900초로 시작 시 검증한다. Task Role의 남은 유효시간에서 5초를 뺀 값이 5초 미만이면 서명이 503이다. SDK 기본 자격 증명 provider를 유지해 ECS Task Role 임시 자격 증명을 갱신한다. production에서는 AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN/PROFILE, AWS_ENDPOINT_URL/AWS_ENDPOINT_URL_S3와 S3_MEDIA_ENDPOINT를 거부한다. 로컬만 개발용 provider/profile 또는 emulator 테스트 자격 증명을 사용할 수 있다. 값은 저장소에 넣지 않는다.

GitHub Environment의 `CD_RUNTIME_SECRETS_JSON` **`post-service` 객체 안에 병합할 예시**(전체 기존 값을 대체하지 말 것):

```json
{
  "S3_MEDIA_ENABLED": "true",
  "AWS_REGION": "ap-northeast-2",
  "S3_MEDIA_BUCKET": "<private-media-bucket-name>",
  "S3_MEDIA_UPLOAD_TTL_SECONDS": "300",
  "S3_MEDIA_READ_TTL_SECONDS": "300"
}
```

기존 GitHub CD → Secrets Manager 버전 고정 → ECS 환경변수 주입/rollback 흐름을 사용한다. 새 자격 증명 Secret은 없다. 이미지에 인증서·파일·AWS key를 추가할 필요 없다. S3 기본 HTTPS CA 검증을 유지하며 사용자 파일은 이미지가 아닌 bucket에 있다. ECS에서 S3 API로 나가는 네트워크와 프론트에서 S3 regional HTTPS endpoint 접근을 준비한다. VPC endpoint 전용 bucket policy로 브라우저 요청까지 차단하지 않도록 실제 경로를 검증한다.

## AWS 사전 작업 (이 변경에서 실행하지 않음)

1. 전용 private general purpose S3 bucket을 운영자가 준비한다. Block Public Access, Bucket owner enforced(ACL 비활성), 기본 암호화(SSE-S3), TLS 전용 bucket policy. 기본 구현은 **versioning을 한 번도 켜지 않은 bucket**을 대상으로 한다. Versioning/정지 bucket은 DeleteObject가 과거 버전을 영구 삭제하지 않으므로 별도 noncurrent-version lifecycle/삭제 정책을 준비·검증하기 전 사용하지 않는다. Object Lock도 별도 설계가 필요하다.
2. **Post ECS Task Role**에 아래 object 범위만 허용한다. Execution Role은 기존 ECR/logs/Secrets Manager 주입 권한을 유지하며 S3 런타임 권한을 넣는 곳이 아니다. CopyObject는 원본 GetObject/대상 PutObject 권한을 사용한다. 기본 구현에 ListBucket/CreateBucket/PutBucketPolicy/ACL 권한은 불필요하다. SSE-KMS를 쓰려면 별도 key policy와 kms:Decrypt/kms:GenerateDataKey를 정확한 키에 허용하고 checksum/CopyObject를 실측한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::<bucket>/post-media/pending/*",
      "arn:aws:s3:::<bucket>/post-media/objects/*"
    ]
  }]
}
```

3. Bucket CORS를 실제 프론트 origin으로 설정한다. 예시의 origin을 그대로 적용하지 않는다. `OPTIONS`는 AllowedMethods에 넣지 않는다.

```json
[{
  "AllowedOrigins": ["https://<frontend-origin>"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type", "content-length", "if-none-match", "x-amz-checksum-sha256", "range"],
  "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges"],
  "MaxAgeSeconds": 300
}]
```

4. `post-media/pending/` prefix에 현재 객체 1일 만료 Lifecycle을 추가한다(기존 lifecycle 유지). 삭제는 비동기라 정확히 24시간에 사라지는 보장은 없다. final 경로는 Worker가 수명을 관리한다. CopyObject는 pending의 ETag가 일치할 때만 허용한다. Bucket policy에 conditional write 강제를 추가한다면 pending PutObject만 대상으로 하고 final CopyObject까지 잘못 차단하지 않는다.
5. MongoDB/DocumentDB에 `post_media` collection과 아래 인덱스를 **트래픽 전** 생성한다. 기존 자동 index 생성에만 의존하지 않는다. DocumentDB 엔진의 다중 문서 트랜잭션·조건부 갱신을 staging에서 검증한다.

```javascript
// 선택한 Post DB에서만 실행. 이미 존재하는 collection은 재생성하지 않는다.
db.createCollection('post_media');
db.post_media.createIndex({ mediaId: 1 }, { unique: true });
db.post_media.createIndex({ objectKey: 1 }, { unique: true });
db.post_media.createIndex({ status: 1, expiresAt: 1 });
db.post_media.createIndex({ status: 1, cleanupAt: 1 });
db.post_media.createIndex({ status: 1, mediaId: 1 });
```

6. 모든 Post 인스턴스를 새 버전으로 바꾼 뒤 미디어 활성화. 구버전은 mediaIds 입력을 거부하고 조회 응답에 첨부가 없으므로 feature flag 활성화 중 구버전 혼용을 피한다. 롤백 시 신규 업로드를 멈추고 S3/DB를 보존한다. `S3_MEDIA_ENABLED=false`이면 기존 첨부가 있는 조회는 503이므로 무중단 미디어 조회용 rollback 수단으로 쓰지 않는다. 정리 Worker도 멈추므로 backlog를 추적한다.
7. 운영 사용자 인증 연동, 업로드 요청 rate limit/사용자 저장량 정책을 별도 확정한 후 공개 쓰기를 개방한다. 이번 요청대로 공개 운영 API는 계속 차단한다. 실제 staging에서 PUT/complete/생성/GET/갱신, 브라우저 CORS, 동영상 Range/seek, URL 만료·Task Role 갱신, 타인 ID·6개·재사용 차단, 취소·만료·부모 삭제 정리, S3 장애 재시도를 검증한다.

## 검증 범위와 공식 참고

`pnpm test`는 설정·정책·HTTP/OpenAPI·실제 SDK URL 서명·S3 응답을 stub한 검증 실패를 확인한다. `RUN_INTEGRATION=1 pnpm test`의 media suite는 **로컬 MongoDB replica set을 실제 사용하고 S3 adapter만 stub**하여 소유권, 원자적 첨부, 동시 요청, rollback, 취소 경합과 정리 재시도를 검사한다. 이를 AWS S3/DocumentDB 연결 검증으로 표현하지 않는다.

- [AWS presigned URL: 재사용, checksum, 임시 자격 증명 만료](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [AWS SDK v3 presigner: signableHeaders/unhoistableHeaders](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)
- [S3 CORS 설정](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
- [Versioning과 삭제 동작](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html)
