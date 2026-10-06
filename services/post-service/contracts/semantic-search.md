# 유사 게시물 검색 계약

`POST /api/v1/posts/similar`는 생성 입력(title/content/category/latitude/longitude/radiusM)에 선택적 `limit`(정수 1–10, 기본 5)을 받는다. 사용자 인증·입력·도메인 검증 후 기능 준비를 확인한다. 로컬·테스트의 `X-User-Id` 및 운영 사용자 인증 미연결 시 503 정책은 생성과 동일하다. 후보 ID, 벡터, 버전, 임계값 등 추가 필드는 400이다. 초안·Outbox는 저장하지 않는다.

200 응답은 `items: [{postId,title,excerpt,category,distanceM,createdAt}]`, `checkStatus: completed|partial`, `partialReasons: []|[CANDIDATE_LIMIT,INDEX_LAG]`, `scope: {radiusM:150,lookbackHours:24}`, `checkedAt`이다. excerpt는 원문 최대 160 Unicode code point다. limit=1도 배열이며 결과가 없으면 빈 배열이다. category는 생성 입력 검증에만 쓰고 후보 필터로 사용하지 않는다. 임계값 이상의 코사인 점수 내림차순, 거리·postId 오름차순으로 정렬한다. 점수는 공개 응답에 노출하지 않는다.

위치 인가 → MapPostQuery.SearchNearbyPosts(150m,200) → MongoDB ACTIVE·미만료·최근 24시간(미래 생성 제외) → 초안 임베딩 → ES script_score → MongoDB 재확인 순서다. ES에는 후보 ID·모델 버전·ACTIVE·생성/만료 시간·벡터 존재 조건을 모두 적용한다. 코사인+1의 점수를 코사인으로 복원한다. 마지막 조회에서 삭제/만료된 글은 제외하고, 해시 불일치는 INDEX_LAG다. 후보 상한 초과는 CANDIDATE_LIMIT, 유효 원본의 ES 문서/현재 버전 벡터 누락은 INDEX_LAG다. 임계값 아래 점수 자체는 부분 결과가 아니다.

모델 미연결·기능 비활성·평가된 임계값 없음, Map/임베딩/ES/Mongo 오류 또는 timeout은 `503 {statusCode:503,code:"SIMILARITY_CHECK_UNAVAILABLE",message:"SIMILARITY_CHECK_UNAVAILABLE"}`이다. ES timed_out/shard 실패도 같은 오류다. 위치 거부는 기존 403이다. 준비 전에는 Map/ES 호출을 하지 않고, 후보가 없으면 임베딩/ES 호출을 하지 않는다. 요청 전체 제한은 10초, Map은 기존 MAP_GRPC_TIMEOUT_MS, ES는 ELASTICSEARCH_TIMEOUT_MS, Mongo 후보 읽기는 maxTimeMS 2초다.

## 모델·검색 문서

EmbeddingProvider는 ready, version, 선택적 initialize(), embed(text, AbortSignal, priority?)를 제공한다. 실제 구현은 E5-small CPU FP32, 버전 `e5-small-761b726-fp32-w480-o64-v1`이며 fixture의 v1과 구분한다. 384개 유한 숫자이며 영벡터·버전 혼합은 허용하지 않는다. 제목/본문은 NFKC·공백 압축 후 개행으로 결합하며 SHA-256 contentHash를 공유한다. 전처리 변경도 새 embeddingVersion이 필요하다.

로컬 모델 파일을 checksum 검사한 뒤 한 번 로드·워밍업한다. 초기화는 앱 시작을 막지 않으며 실패 시 ready=false를 유지한다. 모델 미준비/비활성 상태에서는 Worker가 Redis 연결·소비를 시작하지 않는다. 준비 완료 후 소비를 시작하며 CLI backfill/rebuild도 같은 초기화를 데이터 변경 전에 기다린다. 파일 복구 후 프로세스를 재시작한다.

대칭 비교 입력 모두 `query: `, 패딩 제외 토큰 평균과 L2 정규화를 적용한다. 전체 본문을 최대 480토큰 창(접두사·특수 토큰 포함), 64토큰 중첩으로 처리하고 창별 정규화 벡터를 평균·재정규화한다. 동시성 1, 대기 최대 16건, 대기 포함 10초 제한이다. 요청 우선순위 interactive, 인덱싱 background이며 요청 연속 3건 뒤 대기 중인 인덱싱에 차례를 준다. 취소된 대기는 제거하며, 실행 중인 ONNX 작업은 실제 종료까지 슬롯을 유지한다. API deadline 이후 결과는 버리고 Worker도 실제 종료까지 기다린다. 종료 시 대기를 취소하고 실행 중인 작업을 정리한 뒤 모델을 해제한다.

MongoDB posts 스키마는 바뀌지 않는다. ES `_id=postId`, keyword: postId/status/category/contentHash/embeddingVersion, date: createdAt/expiresAt/sourceUpdatedAt/indexedAt, dense_vector: embedding(384,index:false). 버전별 `post-semantic-v1-read` 별칭은 단일 물리 인덱스의 읽기·쓰기 대상이다. Worker 쓰기는 require_alias=true로 초기화 누락 시 잘못된 동적 인덱스 자동 생성을 막는다. [ES script_score 계약](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/query-dsl-script-score-query.html)에 따라 cosineSimilarity+1을 사용한다. 최대 200개만 계산하므로 ANN 인덱스는 만들지 않는다.

## 소비·복구

기존 `post:events` eventId/eventType/data 형식은 유지한다. `post-semantic-v1`은 Map과 독립된 Consumer Group이고 `post-semantic-v1:dead`가 Dead Letter Stream이다. PostCreated 및 향후 PostExpired/PostDeleted의 envelope 식별자·생산자·schemaVersion=1·occurredAt을 검증한 뒤 최신 MongoDB 원본만 사용한다. 미지원 유형은 ACK, 손상된 대상은 즉시 DLQ다. 동일 해시·버전 벡터를 재사용하고 상태·시간을 다시 저장한다. 원본 없음/삭제/만료는 ES 삭제다.

저장 후 ACK, 실패 시 Pending 유지, XAUTOCLAIM(유예 30초, 작업 제한 10초), 최대 배달 5회 후 DLQ 성공 뒤 ACK한다. DLQ 필드는 streamId/eventId/error/data다. ACK 장애도 재전달되며 멱등 저장한다. 모델 미연결 때 연결/그룹 생성/소비를 시작하지 않는다. 그룹별 Redis lease로 전체 Worker 동시성 1을 유지하고 재구축 중 소비를 일시 중지한다. lease TTL=60초, 갱신=10초이며 소유권 상실 시 작업 signal을 중단한다. 수동 Redis flush/lease 삭제는 실행 중 금지한다.

재구축은 lease → Stream watermark 기록 → 새 물리 인덱스 원본 전체 스캔 → 종료 watermark까지 따라잡기 → 누적 발행 수와 재생 수 및 삭제 watermark로 Stream trim/delete 검사 → 원본/ES 양방향 대조 → refresh → 원자적 별칭 교체 순서다. 보존 기간 이전 원본도 스캔한다. 검증 중 원본 변경/누락 또는 이벤트 손상이 발견되면 전환하지 않고 재시도를 요구한다. 기존 Pending과 그룹 위치는 유지하여 새 별칭에 중복 재처리한다. 진행 상태는 `post-semantic-v1:rebuild` 해시(index/watermark/end/phase/scanned/verified/error)에 남긴다. 실패한 물리 인덱스와 이전 인덱스는 자동 삭제하지 않는다. 복구/rollback 확인 뒤 운영자가 정리한다. [ES alias API](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/aliases.html)의 다중 action으로 전환한다.

실제 모델의 별칭은 `post-semantic-e5-small-761b726-fp32-w480-o64-v1-read`, 그룹은 `post-semantic-e5-small-761b726-fp32-w480-o64-v1`이다. 위 v1 예시는 fixture/기존 버전이며 실제 모델과 별도 인덱스·그룹을 사용한다. 모델/별칭/평가된 임계값을 같은 배포 설정으로 관리한다. 임계값 기본값은 없고 미설정 시 추천은 503이다. 인덱싱은 임계값 없이 실행할 수 있다.

현재 상태 이벤트 생산은 후속 작업이다. 그 전에는 만료 필터·최종 원본 확인이 노출을 막으며 정기 rebuild로 남은 파생 문서를 정리한다. 실제 모델 연결·기준 벡터 일치·전체 연동은 테스트한다. 한국어 중복 품질·운영 임계값·ECS 추론 부하는 별도 평가 대상이다.


## Map 주변 조회 커서 연결

기존 `MapPostQuery.SearchNearbyPosts`의 요청에 `cursor`(필드 5), 응답에 `next_cursor`(필드 3)를 추가한다. 응답 items/postId/distanceM/truncated는 그대로다. Map은 기존 Redis GEO·Cassandra 공간 조회와 커서를 재사용해 페이지당 최대 200개를 반환한다. 첫 페이지의 cursor와 마지막 페이지의 nextCursor는 gRPC에서 빈 문자열이다. Post `GrpcNearbyPosts.page()`는 마지막 nextCursor를 null로 변환하며, 같은 좌표·반경으로 다음 페이지를 요청할 수 있다.

유사도 검색용 `search()`는 150m·limit=200·cursor 없는 한 번의 RPC만 호출한다. 다음 페이지가 있어도 자동으로 추가 조회하지 않으며 기존 CANDIDATE_LIMIT 부분 결과를 유지한다. 구 Map 서버의 nextCursor 없는 응답도 유사도 검색에서는 호환되지만, 일반 페이지 조회에서 truncated=true이고 nextCursor가 없으면 오류로 처리해 다음 페이지를 잃지 않도록 한다.
