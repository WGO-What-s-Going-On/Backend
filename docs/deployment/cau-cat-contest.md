# 중냥이 사진 콘테스트 한 건의 운영 절차

이 PR은 `main`에서 분리한 중냥이 콘테스트 한 건만 추가한다. 병합·배포·운영 생성은 각각 사용자 승인 이후에 실행한다. 기존 5개 이벤트와 일반 글, 공개 생성 API, 인프라·Secret·DB 스키마는 변경하지 않는다.

## 고정 범위

- ID: `post_3b16ea1a-4de6-4a2c-85be-56a64ada2036`
- 작성자: 운영 조회한 WGO 공식 계정 `authorId=1`, 정확한 닉네임 `WGO`.
- NEWS / 투표 NONE / 반경 350m. 자동 후보 선정·투표 보상은 없다.
- 마감: `2026-12-24T12:52:53.893Z` = 한국시간 2026년 12월 24일 **21:52:53.893**. 기존 학과 대항전·고인물 인증 대회의 운영 `expiresAt`와 동일하며, 새 생성 시각부터 30일을 더하지 않는다.
- 위치: **세븐일레븐 중앙대경영관점**. [중앙대 공식 편의시설 안내](https://www.cau.ac.kr/cms/FR_CON/index.do?MENU_ID=1400)에서 310관 B411호, 전화 02-811-1205를 확인했다.
- 좌표: **37.505547607, 126.95470652**. [세븐일레븐 공식 매장찾기](https://www.7-eleven.co.kr/util/storeLayerPop.asp?storeText=%EC%A4%91%EC%95%99%EB%8C%80%EA%B2%BD%EC%98%81%EA%B4%80&hiddentext=none)의 `중앙대경영관점` 검색 결과 지도 마커를 사용한다. 실내 B411호나 고양이 출몰 지점의 실측 GPS 좌표라는 뜻은 아니다. 공식 매장 마커와 OSM 310관 건물 폴리곤은 일치하지 않으므로 운영 반영 승인 시 이 지도 핀을 검토해야 한다. 도로명 대표좌표를 쓰는 외부 업체 안내는 사용하지 않았다.
- 이전 캠퍼스 중심 후보를 대체한 사용자 지정 매장 핀이다. 이 위치의 350m 원이 캠퍼스 전체를 포함한다고 안내하지 않는다. 기존 5개 글의 좌표·반경은 유지한다.

## 참여와 집계

댓글 하나에 직접 촬영한 **이미지 한 장**을 첨부한다. 이미지 없는 댓글·여러 첨부·동영상은 이 ID의 댓글에서만 거절한다. 미디어 소유권·READY 상태 확인과 댓글·공감·Outbox는 기존 트랜잭션을 사용한다. 일반 글과 기존 5개 글은 기존 첨부 규칙을 유지한다.

사진별로 댓글을 나누어 등록하고 해당 댓글에 기존 공감을 남긴다. 사진 자체의 별도 투표·공감·랭킹·보상은 추가하지 않는다. 운영 집계는 `commentId`, `mediaIds`, `authorId`, `reactionCounts`(HELPFUL/AGREE/DIFFERENT)를 함께 읽어 확인한다. 삭제·숨김된 출품은 일반 정책대로 처리한다.

보존된 댓글과 작성자는 마감 후에도 조회할 수 있지만 **마감 시각 자동 결과 스냅샷이나 동결 기능은 이 PR에 없다**. 마감 후 공감 취소·댓글 삭제 등으로 현재 수치가 달라질 수 있어 정확한 시점의 결과가 필요하면 마감 때 운영자가 읽기 전용 집계·백업을 남겨야 한다. 이미지 signed URL은 단기이므로 결과 보관에는 URL 대신 mediaId/commentId를 기록하고 정상 조회 경로로 갱신한다.

## 승인 이후 배포·생성

1. 기존 두 원본 이벤트의 ACTIVE/NONE·작성자·좌표·반경·공통 마감을 운영에서 재조회한다. 새 ID와 동일 제목의 글이 없는지 확인하고 Mongo/Redis 백업 및 복원을 검증한다.
2. 변경된 런타임 서비스는 **Post·Moderation·Notification**이다. Map·User는 계약 테스트만 추가하며 배포할 필요가 없다. SQL 스키마·migration 파일·CD·리소스 설정은 수정하지 않는다. 자동 CD가 기존 idempotent Notification migration Job을 실행할 수 있으므로 실제 리소스 부족 시 승인 범위 밖의 조정을 자동으로 시도하지 않는다.
3. 세 서비스의 모든 기존 Pod(종료 중 포함)가 새 digest로 완전히 교체되고 readiness가 정상일 때만 생성한다. 구 Notification은 새 ID의 절대 마감을 거절하고 구 Moderation은 정책을 거절하므로 혼합 버전에서는 생성하지 않는다. 생성 이후에는 정책을 모르는 버전으로 롤백하지 않는다.
4. `scripts/campus-rollout-evidence.mjs`로 최신 rollout 증거를 수집해 `cau-cat-contest.manifest.json`의 운영용 복사본 `rollout`에 넣는다. 기존 CLI의 5분 이내 증거 검증을 그대로 사용한다.
5. Post 패키지에서 `npm run campus-events -- <운영-manifest.json> --cat-contest`로 dry-run한다. 승인 후에만 같은 명령에 `--apply`를 추가한다. 기본값은 dry-run이다. 앱·공개 API·GPS 조작은 사용하지 않는다.
6. CLI가 User gRPC로 WGO/1/ACTIVE, Map 지역, 원본 두 이벤트를 검증한다. 신규 글·bucket 카운터·만료·PostCreated Outbox는 한 Mongo 트랜잭션으로 저장한다. 원본 5개는 갱신하지 않는다. 같은 ID 재실행은 일치 여부만 검증하고 최초 시각·마감·상태를 유지하며 숨김/삭제/만료를 되살리지 않는다.
7. Post NONE/ACTIVE/고정 마감, Outbox/Map 인덱스, Moderation projection 및 due score=실제 마감, Notification receipt를 확인한다. ExpirationWorker가 마감부터 참여를 거절하고 PostExpired를 정상 발행한다. 전파에는 기존 poll/queue 지연이 있다.

Frontend/Vercel은 이 PR에서 수정하거나 접근하지 않는다. 기존 프론트의 이벤트 350m 허용 목록은 신규 ID를 포함하지 않을 수 있으므로 담당자가 신규 ID의 radiusM=350 적용을 별도로 확인해야 한다. 백엔드 위치 검증은 새 위치의 350m를 사용하며 일반 글 정책을 바꾸지 않는다.
