# Post Service Scaling Strategy

## 문제와 현재 결정

Post Service의 `postId`는 제품 용어인 `boardId`에 해당한다. 한 게시물에 댓글과 반응이 몰리면 `postId`만으로는 미래의 물리적 샤딩에서 쓰기를 분산할 수 없다. 이전 구현은 댓글·반응·참여마다 같은 `posts` 문서의 카운터를 증가시켜 현재 단일 replica set에서도 문서 경합을 만들 수 있었다.

현재는 MongoDB replica set을 유지한다. 실제 Sharded Cluster와 shard key는 부하 측정 전까지 도입하거나 확정하지 않는다. 댓글, 반응, 참여자는 이미 별도 컬렉션이며 무한히 자라는 embedded array는 없다.

## 준비된 데이터 모델

| 컬렉션 | 역할 | 논리적 분할 |
| --- | --- | --- |
| `posts` | 본문, 위치 스냅샷, 상태, 생성 시 고정한 `bucketCount` | `postId` |
| `post_comments` | 댓글과 `bucketId` | `postId + bucketId` |
| `post_reactions` | 사용자별 LIKE와 `bucketId` | `postId + bucketId` |
| `post_participants` | 사용자별 참여 기록 | 현재 `postId + userId`; 향후 분할 후보 |
| `post_counters` | `bucketId`·지표별 증가분 | `postId + bucketId + metric` |
| `outbox_events` | 도메인 이벤트 전송 | 별도 운영 인덱스 |

`PartitionStrategy.resolveBucket(entityId, bucketCount)`는 SHA-256 앞 32비트의 나머지로 bucket을 정한다. 댓글은 `commentId`, 반응은 `userId:type`, 참여 카운터는 `userId`를 입력으로 사용한다. 같은 엔터티는 같은 bucket에 간다. API와 이벤트에는 `bucketId`를 노출하지 않는다. 반응의 유일 규칙은 기존 `(postId, userId, type)` 인덱스가 유지한다.

새 게시물의 `bucketCount`는 `POST_BUCKET_COUNT` 설정값이며 기본값 1이다. 생성 후에는 바꾸지 않는다. 기존 게시물에 필드가 없으면 1로 읽고, 기존 댓글에 `bucketId`가 없으면 bucket 0에서 읽는다. 운영 중 bucket 수를 변경하거나 기존 데이터를 재분배하는 기능은 이번 범위에 없다. `NORMAL=1`, `HOT=8` 같은 값은 확정된 운영 정책이 아니다.

## 카운터와 조회

새 활동은 `posts.counters`를 갱신하지 않는다. 콘텐츠·bucket별 카운터 증가·Outbox는 기존 MongoDB 트랜잭션에서 함께 커밋된다. 새 게시물의 카운터 기준값은 0이다. 이전 게시물의 `posts.counters`는 읽기 기준값으로 보존하고, 상세 조회에서 `post_counters` 증가분을 합산한다. `updatedAt`은 이 변경 이후 댓글·반응·참여 시각이 아니라 게시물 메타데이터 수정 시각이다. `viewCount`는 현재 쓰기 경로가 없어 기존 기준값만 반환한다. 새 카운터는 bucket별 문서이므로 bucket 1개인 일반 게시물에는 해당 문서 경합이 남는다. 이는 측정 후 조정할 대상이다.

현재 상태 변경 명령은 구현되어 있지 않다. 향후 게시물 만료·삭제를 추가할 때는 상태 조회와 댓글·반응 트랜잭션의 동시 실행을 함께 설계해야 한다. Post 문서의 조건부 카운터 갱신이 사라졌으므로 상태 변경과 활동 기록의 경합을 기존 방식에 맡길 수 없다.

댓글 조회는 게시물의 고정 `bucketCount`만큼 bucket별로 커서 조건을 적용해 병렬 조회한다. 각 bucket에서 요청 수만큼 읽고 `(createdAt DESC, _id DESC)`로 병합한 뒤 요청 수만 반환한다. 기존 API의 커서 형태와 응답은 같다. bucket 0 질의는 `bucketId`가 없는 기존 댓글도 포함한다. 현재 기본값 1에서는 한 bucket만 조회한다. bucket 수에 비례한 읽기 비용이 있으므로 운영 지표를 확인한 뒤 라우팅이나 merge 최적화를 검토한다. Offset pagination은 사용하지 않는다.

## 인덱스와 비용

| 인덱스 | 목적과 읽기 이점 | 쓰기 비용 |
| --- | --- | --- |
| `posts(postId)` unique | 상세·상태·batch 조회 | 게시물 생성 시 1회 갱신 |
| `posts(status, expiresAt)` | 향후 만료 대상 스캔; 현재 요청 경로에서는 사용 안 함 | 게시물 생성·상태 변경 시 갱신 |
| `post_comments(postId, bucketId, createdAt DESC, _id DESC)` | bucket별 최신 댓글과 커서 | 댓글마다 갱신 |
| `post_comments(commentId)` unique | 댓글 식별자 중복 방지 | 댓글마다 갱신 |
| `post_comments(postId, authorId, mutationId)` partial unique | WS 재전송 멱등 조회 | mutationId가 있는 댓글만 갱신 |
| `post_reactions(postId, userId, type)` unique | LIKE 중복 방지와 기존 반응 조회 | 반응마다 갱신 |
| `post_counters(postId, bucketId, metric)` unique | 상세 카운터 합산·bucket별 갱신 | 활동마다 갱신 |

현재 API에 반응 시간순 목록, 게시물 위치 검색, 작성자·카테고리 목록은 없다. 따라서 `(postId,bucketId,createdAt)` 반응 인덱스와 `posts.location` 인덱스는 만들지 않았고, 사용되지 않던 게시물 작성자·카테고리 인덱스는 제거했다. 위치 검색은 Map Service가 소유한다. 참여자와 Outbox의 기존 인덱스는 유지한다.

## 배포와 이전 데이터

1. 새 인덱스와 `post_counters` 컬렉션을 배포한다. 프로덕션에서 자동 인덱스 생성이 꺼져 있다면 배포 전에 수동 생성한다. 기존 게시물마다 bucket 0의 세 지표를 **0으로 초기화**해 첫 동시 갱신에서 upsert 경합을 줄인다. 이 과정은 `posts.counters` 값을 복사하지 않는다. 기존 댓글 인덱스는 새 인덱스 사용을 확인한 뒤 제거한다.
2. 코드 배포 후 새 활동만 `post_counters`에 기록한다. **이전 `posts.counters`를 새 컬렉션으로 복사하지 않는다.** 기존 값은 기준값이므로 복사하면 이중 집계된다.
3. 기존 게시물의 `bucketCount`와 기존 댓글·반응의 `bucketId`는 필요 시 1과 0으로 점진적으로 채울 수 있다. 읽기 경로는 백필 전에도 호환된다.
4. 충분히 검증한 뒤 사용되지 않는 작성자·카테고리 게시물 인덱스를 제거한다. 롤백 시 이전 바이너리는 새 `post_counters` 증가분을 읽지 못하므로 API 카운터가 낮아진다. 코드 롤백 전에 증가분을 기존 기준값에 합치는 별도 절차 또는 신버전 유지가 필요하다.

## 확장 판단과 향후 물리적 샤딩

부하 테스트와 운영 지표인 동시 구독자 수, 댓글·반응 write TPS, 게시물 read QPS, MongoDB p95/p99 쓰기 지연, bucket별 분포를 함께 측정한다. 임계값은 아직 정하지 않는다. 실제 샤딩 시에는 컬렉션별 cardinality, chunk 분포, 중복 방지 유일 인덱스, 댓글 읽기 fan-out을 검토한다. `(postId, bucketId)` compound와 해시 기반 후보를 비교하되 현재 shard key를 확정하지 않는다. MongoDB shard key와 유일 인덱스의 제약이 충돌할 수 있으므로 반응의 중복 방지 방식도 함께 설계해야 한다.

운영 중 `bucketCount`를 늘리면 과거 데이터와 새 데이터가 다른 분포를 갖는다. 조회 대상 bucket, 커서, 재분배, 롤백을 포함한 Dynamic Repartitioning 설계를 별도 ADR로 결정한다.

## 교환 비용

bucket별 쓰기 분산 여지를 얻는 대신 인덱스와 카운터 문서가 늘고, 댓글 읽기·병합 비용이 bucket 수에 비례한다. 현재 단일 replica set에서는 bucket이 물리적 노드 간 쓰기를 분산하지 않는다. Sharded Cluster를 도입하면 라우팅과 운영 복잡성이 추가된다.
