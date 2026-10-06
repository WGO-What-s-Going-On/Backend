# 게시물 작성 전 의미 기반 유사 게시물 추천 계획

> 구현 상태(2026-10-06): 실제 모델을 제외한 Post API·Map 후보 RPC·ES 검색·이벤트 인덱싱·원본 재구축 기반을 구현하고 실제 저장소 통합 테스트를 완료했다. 모델 미연결 상태에서는 추천 503/Worker 미실행이다. 완료 범위와 검증 결과는 [SEMANTIC_VERIFICATION.md](SEMANTIC_VERIFICATION.md), 현재 계약은 [semantic-search.md](contracts/semantic-search.md)를 참조한다. 아래 모델 품질·성능 실험은 후속 계획이다.


작성일: 2026-10-06 · 상태: **검토용 제안 / 구현 전**

이 문서는 현재 코드를 조사한 결과와 앞으로 구현할 계약·검증 순서를 정리한다. 아래 API, RPC, 설정, 스크립트, Compose 추가 파일은 별도 표시가 없으면 **아직 존재하지 않는 제안**이다. 이 문서 작성 과정에서 애플리케이션 구현이나 인프라 실행은 하지 않았다.

## 1. 목표와 권장 방향

사용자가 제목·본문·위치를 입력한 뒤 등록하기 전에, **Map Service가 최대 200개의 게시물 후보를 반환하고 Elasticsearch가 초안과의 유사도를 비교하여 높은 순서대로 추천**한다. 기본 목록은 상위 5개이며 `limit=1`이면 가장 유사한 게시물 한 개를 반환한다. 사용자는 기존 게시물로 이동하거나 작성을 계속할 수 있다.

권장 흐름은 `작성 초안 → Post → Map 후보 조회 → 임베딩 → Elasticsearch 벡터 비교 → Post 원본 확인 → 목록 반환`이다. MongoDB는 게시물 원본, Elasticsearch는 Post가 관리하는 재구축 가능한 검색 인덱스다.

**선택한 실행 구성:** 임베딩 모델은 Post Service 내부에 상주시킨다. TypeScript에서 Transformers.js/ONNX Runtime을 사용하며, 운영 임베딩 전용 Python 서버나 HTTP 호출은 추가하지 않는다. Python은 선택적인 오프라인 학습·모델 변환에 사용한다. 벡터 저장·비교는 Elasticsearch가 담당한다.

이미 생성된 게시물은 생성 이벤트 처리 시 벡터를 추출해 ES에 저장하고 재사용한다. 작성 중인 초안은 추천 요청 시 벡터를 추출한다. 따라서 후보 200개의 텍스트를 요청마다 다시 임베딩하지 않는다. 최초 요구사항인 생성 전 추천을 유지하며, 추천 조회가 초안을 먼저 저장하지 않는다.

이번 기능의 성공은 같은 사건에 대한 중복 작성을 줄일 수 있는 추천 목록을 제공하는 것이다. **동일 사건의 생성을 강제로 막는 기능은 별도 정책**이다. 문장 의미가 비슷하다는 것만으로 사건이 같다고 확정할 수 없고, 사전 조회 이후 동시 작성과 인덱스 반영 지연도 발생한다. 생성 API에 유사도 기반 `409`를 추가하거나 새 글을 자동 병합하지 않는다.

## 2. 현재 구현에서 확인한 사항

| 항목 | 코드 기준 현재 상태 | 계획에 미치는 영향 |
| --- | --- | --- |
| 게시물 생성 | `CreatePost.execute()`가 UUID 생성, Map 위치 인가, MongoDB 게시물·Outbox 트랜잭션을 실행 | 동일 사건 검사 없음. 새 추천 조회는 생성 Command와 분리 |
| 요청 중복 | 게시물 생성에는 요청 멱등 키가 없고 댓글의 `mutationId` 처리만 존재 | 네트워크 재시도 중복과 의미상 중복은 별개. 생성 멱등성은 후속 과제 |
| Map 주변 조회 | `GET /internal/v1/posts/nearby`, 거리·ACTIVE·만료 필터, 거리순·postId순 커서 페이지 | 공간 검색 로직 재사용 가능 |
| Map 호출자 | 주변 HTTP 조회는 `http-gateway` JWT만 허용. Post의 gRPC는 생성·참여 위치 인가 RPC 두 개 | Post용 주변 조회 gRPC와 권한표 추가 필요 |
| 반경 | Post 생성은 1–10,000m, Map 주변 검색은 150/250/350m만 허용 | 생성 반경과 추천 검색 반경을 구별해야 함 |
| 후보 완전성 | GEO 실패 또는 유효 결과 0개일 때 Cassandra/H3 fallback. GEO 일부 누락은 결과가 남아 있으면 복구되지 않음 | 추천을 반경 내 전체 사건 검사라고 표현할 수 없음 |
| Map 조회 비용 | 응답 `limit` 적용 전에 전체 후보의 Cassandra 위치·상태를 순차 조회 | 페이지 크기만 줄여도 Map 내부 비용은 줄지 않음. 밀집 지역 부하 시험 필요 |
| 이벤트 | `PostCreated`에 ID·좌표·분류 등이 있고 제목·본문은 없음 | 검색 Worker는 Post 소유 MongoDB에서 내용을 읽음 |
| 기존 소비자 | Map `post-map`, WS Gateway `post-realtime` 그룹 | 검색 전용 그룹을 추가해야 모든 소비자가 독립적으로 수신 |
| 상태 변경 | Post는 현재 생성·댓글·반응·참여 이벤트만 발행. Map에는 삭제·만료 이벤트 소비 계약이 있음 | 미구현 상태 이벤트를 이미 제공되는 것으로 가정하지 않음 |
| 인증 | Post 공개 작성과 Map 위치 갱신은 운영 사용자 인증 연동 전까지 차단 | 로컬 검증과 운영 공개 조건을 분리 |
| 로컬 저장소 | Post MongoDB replica set + Redis 6380, Map Cassandra + 별도 Redis 기본 6381 | 통합 실험에서는 Map도 Post의 Redis 6380 사용 |

근거: [생성 Command](./src/post/application/commands.ts), [도메인 입력 제한](./src/post/domain/post.ts), [Outbox](./src/post/infrastructure/outbox.worker.ts), [Map 조회 구현](../map-service/src/post-index.ts), [Map 서버](../map-service/src/server.ts), [Map README](../map-service/README.md), [이벤트 계약](../map-service/contracts/post-events.md), [내부 인증 계약](../../docs/contracts/service-authentication.md).

상위 `ARCHITECTURE.md`의 일부 주변 검색 설명은 계획 상태로 남아 있으나, 현재 Map 코드에는 주변 조회와 공간 인덱스가 구현되어 있다. 본 계획은 코드와 Map 계약을 기준으로 한다.

## 3. 서비스 책임과 요청 순서

| 구성 요소 | 책임 |
| --- | --- |
| 클라이언트 | 작성 완료 후 등록 직전 추천 조회, 목록 표시, 기존 글 이동/작성 계속 선택 |
| HTTP Gateway | 사용자 인증, 내부 신원 헤더 정제, Post로 라우팅, 요청 빈도 제한 |
| Post Service | 초안 검증, 위치 인가 요청, Map 후보 수집, 임베딩·검색 조합, 최종 원본 확인 |
| Map Service | 좌표·반경·거리·활성 상태로 후보를 추려 ID와 거리를 최대 200개 반환 |
| 임베딩 실행부 | Post 내부의 상주 모델로 텍스트를 의미 벡터로 변환. HTTP 호출 없이 내부 어댑터로 실행 |
| Elasticsearch | 후보 ID로 제한한 벡터 유사도 계산과 정렬 |
| 검색 Worker | Post 내부 백그라운드 작업으로 이벤트를 소비하고 상주 모델을 사용해 검색 벡터를 비동기로 갱신 |

1. 클라이언트가 초안을 `POST /api/v1/posts/similar`로 전송한다.
2. Post가 입력·인증을 검증하고 기존 `CheckPostCreation`으로 위치 인가를 확인한다.
3. Post가 새 `MapPostQuery.SearchNearbyPosts` RPC로 후보를 한 번 조회한다. Map은 기존 공간 필터 로직을 재사용한다.
4. Map은 중복 제거 후 거리순 후보 ID·거리를 최대 200개 반환한다. 범위 내 후보가 더 있으면 `truncated=true`를 반환하고 Post는 `CANDIDATE_LIMIT` 부분 결과로 표시한다. 기존 HTTP 조회의 최대 100개 제한과 신규 gRPC 계약을 구분한다.
5. Post가 자기 MongoDB에서 후보를 일괄 조회해 ACTIVE·만료·생성 시각 조건을 확인한다. 후보가 없으면 임베딩과 ES 호출을 생략한다.
6. Post의 상주 모델로 초안의 벡터를 만들고 **후보 ID 조건을 ES 점수 계산 내부 필터에 넣는다.** ES는 미리 저장된 게시물 벡터와 비교한다. 전체 ES 검색 후 Map 후보와 교집합을 구하는 방식은 사용하지 않는다.
7. 최대 200개 후보의 점수를 받아 임계값을 적용하고, MongoDB 원본 상태·본문 해시를 다시 확인한다. 삭제·만료·오래된 본문으로 계산한 결과를 제외한 뒤 상위 N개를 고른다.
8. 목록·검색 범위·부분 결과 여부를 반환한다. 초안은 저장하거나 이벤트로 발행하지 않는다.

최종 목록은 코사인 유사도 내림차순, 동점일 때 거리 오름차순, postId 오름차순으로 정렬한다. 사용자에게 보여줄 제목·요약은 MongoDB 원본에서 가져온다. 다른 서비스의 DB에 직접 접속하지 않는다.

```text
기존 글 생성 → MongoDB + Outbox → post:events
  → Post 내부 검색 Worker → 상주 모델로 벡터 추출 → Elasticsearch 저장

작성 초안 → Post → Map gRPC → 최대 200개 후보 ID·거리
  → MongoDB에서 후보 원본 확인
  → Post 상주 모델로 초안 벡터 추출
  → Elasticsearch에서 후보 ID 안의 벡터만 비교
  → 원본 재확인 → 유사도 내림차순 상위 N개 반환
```

## 4. 공간·시간·분류 정책 초안

Map 후보 상한 200개와 Post 내부 모델 상주·ES 비교는 선택한 설계다. 나머지 반경·시간·기본 반환 개수는 초기 실험값이다.

| 정책 | 초기 제안 | 확인할 위험 |
| --- | --- | --- |
| 검색 중심 | 새 게시물의 요청 좌표 | 사용자 위치와 게시물 중심은 기존 위치 인가로 검증 |
| 추천 반경 | 서버 설정 350m | 생성 `radiusM`과 독립. 넓은 사건은 350m 밖에서 누락될 수 있음 |
| 생성 반경 | 기존 1–10,000m 입력을 위치 인가에 사용 | 추천 요청 때문에 기존 생성 계약을 축소하지 않음 |
| 시간 범위 | 서버 기준 최근 24시간 | 하루 이상 지속되는 사건의 누락 여부 평가 |
| 유효 상태 | ACTIVE, `expiresAt`이 없거나 현재보다 미래 | 현재 `expiresAt=null`이 기본이므로 시간 범위가 별도로 필요 |
| 분류 | 초기에는 서로 다른 category도 비교 | 동일 사건을 다른 분류로 올리는 경우를 놓치지 않도록 함 |
| 후보 상한 | Map 신규 gRPC에서 거리순 최대 200개 반환 | 밀집 지역의 더 먼 동일 사건 누락과 truncated를 계측 |
| 반환 개수 | 기본 5, 최대 10; limit=1은 최상위 한 개 | 임계값 미달이면 억지로 채우지 않음 |

24시간 필터는 현재 Map 계약에 없으므로 Post가 적용한다. 따라서 가까운 오래된 글이 후보 200개를 채워 최신 글이 제외될 수 있다. 평가에서 이런 누락이 나타나면 Map에 생성 시각을 투영하고 시간 필터를 **후보 상한 전에** 적용하는 계약 변경을 별도로 포함한다. 후보 상한·시간 필터·GEO 누락에 따른 손실과 임베딩 품질 손실을 나누어 측정한다.

## 5. 의미 추출과 Elasticsearch 검색 방식

### 5.1 임베딩 모델

Elasticsearch에 문자열을 저장하는 것만으로 의미가 추출되지는 않는다. 별도 임베딩 모델이 문장을 벡터로 만들고 Elasticsearch가 벡터를 비교한다.

초기 로컬 후보는 **`intfloat/multilingual-e5-small`**이다. 한국어를 포함한 다국어 모델이며 벡터는 384차원이다. 동일 사건의 표현 비교는 대칭 유사도 작업으로 보고 초안과 기존 글 모두 `query: ` 접두사를 적용한다. 모델 카드의 입력 한계는 512토큰이다. 모델 revision·토크나이저·추론 패키지 버전·정규화를 고정한다. [모델 제공자 문서](https://huggingface.co/intfloat/multilingual-e5-small/blob/main/README.md)

로컬 검증과 운영 모두 **Post 내부의 TypeScript 임베딩 어댑터**를 사용한다. Transformers.js/ONNX Runtime과 호환되는 모델 파일·토크나이저를 고정하고, Post 시작 시 한 번 로드한 뒤 워밍업한다. 모델의 ONNX 변환 지원과 원본 대비 벡터·추천 품질을 먼저 검증한다. 로컬 평가 스크립트도 동일 어댑터를 사용하며 독립 PoC 서버를 띄우지 않는다. [Transformers.js 사용자 모델 안내](https://huggingface.co/docs/transformers.js/en/custom_usage)

임베딩 어댑터는 Nest singleton으로 모델 수명주기를 관리한다. 요청 경로와 Post 내부 검색 Worker가 같은 실행 큐·모델 인스턴스를 사용한다. 토큰화나 전처리 때문에 이벤트 루프 지연이 나타나면 Post 프로세스 내부의 장기 실행 Worker Thread로 모델 소유권을 옮긴다. 요청마다 스레드나 모델을 생성하지 않으며, 스레드별 모델 복제에 따른 메모리 증가도 측정한다. 자세한 운영·성능 정책은 10절에 정의한다.

외부 유료 API 키 없이 재현 가능한 실험을 우선한다. ELSER는 영어 문서·질의에 권장되므로 한국어 기본 모델로 채택하지 않는다. [Elastic ELSER 안내](https://www.elastic.co/docs/explore-analyze/machine-learning/nlp/ml-nlp-elser)

### 5.2 텍스트와 긴 본문 처리

- 입력은 공백을 정리한 `제목 + 줄바꿈 + 본문`이다. 장소명·부정 표현·숫자·시간 표현을 지우지 않는다.
- 제목 120자·본문 5,000자까지 허용되는 기존 계약을 유지한다. 512토큰 뒤를 조용히 버리지 않는다.
- 초기 실험은 접두사·특수 토큰을 포함해 모델 한도 이내인 최대 480토큰 창, 64토큰 중첩으로 전체 입력을 분할한다. 각 창의 정규화 벡터를 평균한 뒤 다시 정규화해 게시물당 하나의 벡터를 만든다. 초안과 기존 글에 동일 규칙을 사용한다.
- 이 평균 방식은 긴 글의 특정 사건을 희석할 수 있는 **실험 가설**이다. 핵심 정보가 본문 끝에 있는 데이터가 기준을 통과하지 못하면, 창별 벡터와 게시물별 점수 집계 방식으로 바꾸는 비용을 비교하고 모델·저장 형식을 확정한다.
- `embeddingVersion`은 모델 revision, 토크나이저, 전처리, 접두사, 창 분할, pooling·정규화·집계 규칙, ONNX 산출물과 양자화 구성을 함께 식별한다. 같은 차원이어도 버전이 다르면 비교하지 않는다.
- 같은 주제의 다른 사건, “화재 발생”과 “화재가 아니라 훈련”, 장소·시간이 다른 사고를 별도 평가한다. 임베딩은 사건 식별자의 대체물이 아니다.

### 5.3 인덱스와 점수

물리 인덱스 예: `post-semantic-v1`, 버전별 읽기 별칭: `post-semantic-v1-read`. 각 Post 배포 버전은 모델·검색 별칭·임계값을 한 설정 묶음으로 고정한다. 문서 `_id=postId`, shard 1개·replica 0개는 로컬 전용 설정이다. 모델 교체 절차는 11절에 정의한다.

| 필드 | ES 타입/의미 |
| --- | --- |
| `postId` | `keyword`, 식별·안정적 정렬 |
| `status`, `category` | `keyword` |
| `createdAt`, `expiresAt`, `sourceUpdatedAt`, `indexedAt` | `date`, 만료 없음은 null |
| `contentHash` | 제목·본문의 정규화된 해시, 현재 원본과 비교 |
| `embeddingVersion` | `keyword`, 같은 의미 공간의 벡터만 비교 |
| `embedding` | `dense_vector`, `dims: 384`, `index: false` |

초기 후보 상한이 200개이므로 `script_score`로 후보 전체의 코사인 유사도를 계산한다. 근사 최근접 검색 인덱스는 우선 도입하지 않는다. Elastic 문서도 점수 계산 대상을 내부 query로 제한할 것을 설명한다. `search.allow_expensive_queries`가 허용되어야 한다. [공식 script_score 문서](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-script-score-query)

계획한 쿼리 구조는 다음과 같다. 아래의 ID·시각·벡터·버전은 요청마다 실제 값으로 구성한다.

```text
size = 후보 상한(200)
script_score.query.bool.filter =
  terms(postId, Map 반환 ID 중 MongoDB 조건을 통과한 ID)
  term(status, ACTIVE)
  range(createdAt, 요청 시각 - 24시간 이상)
  (expiresAt 없음 OR expiresAt > 요청 시각)
  term(embeddingVersion, 현재 버전)
  exists(embedding)
script_score.script = cosineSimilarity(params.vector, 'embedding') + 1.0
```

`rawSimilarity = _score - 1.0`으로 복원하여 임계값을 적용한다. 이 수치는 중복 확률이나 정확도 퍼센트가 아니다. 모델별 점수 분포가 다르므로 `0.8 이상이면 동일 사건` 같은 값을 사전에 확정하지 않는다. API에는 점수 대신 목록 순서를 제공하고 평가 로그에는 원점수·정책 버전을 남긴다.

후보 규모가 증가해 지연 목표를 넘을 때만 ANN/kNN을 비교한다. 전환 시에도 Map ID 필터를 kNN 내부 필터로 적용하고 exact 결과 대비 recall과 점수 변환 차이를 다시 검증한다.

## 6. 제안 API와 RPC 계약

### 6.1 공개 추천 API

`POST /api/v1/posts/similar` — 읽기 성격의 요청이며 게시물을 생성하지 않는다. 성공 상태는 **200**으로 명시한다. NestJS POST 기본 201에 맡기지 않는다.

```json
{
  "title": "강남역 출구 앞에서 차량 사고가 난 것 같아요",
  "content": "버스와 승용차가 부딪혀서 차가 밀리고 있습니다.",
  "category": "INCIDENT",
  "latitude": 37.4979,
  "longitude": 127.0276,
  "radiusM": 250,
  "limit": 5
}
```

제목·본문·분류·좌표·생성 반경은 기존 생성 규칙을 재사용한다. `limit`만 선택 필드이며 기본 5, 정수 1–10이다. 최상위 한 개만 필요한 호출자는 `limit=1`을 사용한다. 이때도 응답은 같은 `items` 배열이며 임계값 통과 결과가 없으면 빈 배열이다. client가 `candidateIds`, 임계값, 임베딩 버전을 지정할 수 없다. 의미 있는 입력이 거의 없는 경우의 품질은 평가 데이터에 포함한다.

```json
{
  "items": [
    {
      "postId": "post_123e4567-e89b-12d3-a456-426614174000",
      "title": "강남역 버스 접촉 사고",
      "excerpt": "출구 앞 버스와 차량 사고로 정체 중입니다.",
      "category": "INCIDENT",
      "distanceM": 83,
      "createdAt": "2026-10-06T01:20:00.000Z"
    }
  ],
  "checkStatus": "completed",
  "partialReasons": [],
  "scope": { "radiusM": 350, "lookbackHours": 24 },
  "checkedAt": "2026-10-06T01:25:00.000Z"
}
```

`excerpt`는 원문 앞부분의 길이 제한 요약(예: 최대 160자)으로, 생성형 모델이 만들어 낸 사건 설명이 아니다. `completed`는 반환된 검색 범위의 처리가 완료되었다는 뜻이며 전체 게시물에 중복이 없다는 보증이 아니다.

| 상황 | 응답/사용자 경험 |
| --- | --- |
| 후보 없음 또는 임계값 통과 없음 | `200`, `items: []`, `completed` |
| 후보 상한 초과 | `200`, `partial`, `CANDIDATE_LIMIT` |
| Map 후보 중 원본은 있지만 ES 문서·현재 버전이 없음 | `200`, `partial`, `INDEX_LAG`; 사용 가능한 결과만 반환 |
| 검색 시점과 최종 원본의 본문 해시 불일치 | 해당 결과 제외, `partial`, `INDEX_LAG` |
| Map·임베딩·ES·MongoDB 조회 실패/timeout | `503`, 안정적인 `SIMILARITY_CHECK_UNAVAILABLE` 오류 코드. 빈 성공 목록으로 위장하지 않음 |
| ES timed_out 또는 shard 실패 | 완전한 검색으로 취급하지 않고 `503` |
| 잘못된 입력 | `400` |
| 위치 없음·오래됨·범위 밖 | 기존 위치 인가 규칙의 `403` |
| 인증 실패/권한 없음 | 인증 계약에 따른 `401/403`; 로컬 `X-User-Id` 검증은 기존 동작 유지 |
| 요청 빈도 초과 | Gateway `429`, 재시도 안내 |

운영 사용자 인증이 미연동이면 기존 쓰기 API와 동일하게 운영 공개를 차단한다. 정상 인증 후 의존성 장애가 난 경우 UI는 “유사 게시물 확인을 완료하지 못했습니다”와 재시도/작성 계속을 제공한다. 실제 생성 요청은 기존 인증·위치 인가를 다시 수행한다.

초기에는 등록 버튼을 누르는 시점에 한 번 검사한다. 입력마다 조회하는 UX는 추후 필요하면 debounce와 취소를 추가한다. 요청 중 초안이 바뀌면 클라이언트가 이전 응답을 버리고 최신 초안을 검사한다. 추천 조회 결과를 생성 권한 토큰으로 사용하지 않는다.

### 6.2 Post → Map 신규 gRPC

새 `contracts/map-post-query.proto`를 Map과 Post에 추가한다. 기존 `MapAuthorization`의 의미를 바꾸지 않고 같은 gRPC 서버에 조회 서비스를 등록한다.

```text
service MapPostQuery
  SearchNearbyPosts(NearbyPostsQuery) -> NearbyPostsResult

NearbyPostsQuery:
  latitude: double, longitude: double, radius_m: uint32
  limit: uint32  // Post는 200을 전달; 허용 범위 1–200
NearbyPostsResult:
  items: repeated { post_id: string, distance_m: double }
  truncated: bool  // 반환 상한 뒤에 후보가 더 있으면 true
```

- 신규 RPC는 반경 150/250/350, limit 1–200을 허용하고 잘못된 값은 거부한다. 첫 구현은 기존 `PostIndex.nearby()`의 내부 조회 결과에서 상한 다음 후보의 존재까지 확인하여 `truncated`를 결정한다. 내부 함수의 limit은 HTTP 검증과 분리하여 재사용한다. 기존 HTTP API의 limit 1–100과 커서 계약은 유지한다.
- Map은 제목·본문·벡터를 반환하지 않는다. 신규 RPC에서 최대 200개의 ID·거리만 반환하며 검색 전체의 완전성을 보증하지 않는다. 상한 검증은 Post에서도 방어적으로 수행한다.
- 허용 호출자는 `post-service`만이다. 기존 Post의 ES256 서명과 Map의 공개키 검증을 재사용하고 RPC별 권한표에 새 메서드를 추가한다. 새 RPC에 HS256 호환을 확장하지 않는다.
- `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`를 계약에 명시한다. 내부 인증 실패는 외부 사용자의 로그인 실패로 오인시키지 않고 의존성 오류로 처리·경보한다.
- Map 배포 후 Post 클라이언트를 배포한다. 기존 HTTP 주변 조회와 두 위치 인가 RPC의 동작을 회귀 검증한다.
- 초기 전체 요청 예산 2초, 위치 인가 500ms, Map 후보 RPC 500ms, 임베딩 대기+추론 600ms, ES 200ms를 상한 초안으로 둔다. 남은 예산을 전달하고 MongoDB 확인·직렬화 여유를 확보한다. 실측 전 SLO로 확정하지 않는다.

## 7. 검색 인덱스 동기화와 복구

### 7.1 생성과 별도로 처리

1. 기존 MongoDB + Outbox 생성 트랜잭션과 `PostCreated` 형식을 유지한다.
2. Post 내부 Worker가 `post:events`를 새 그룹 `post-semantic-v1`으로 소비한다. 같은 모델 버전의 Post 인스턴스들이 이 그룹에서 분담하며 Map/Realtime 그룹에 가입하지 않는다. 모델 버전 전환 때는 별도 그룹을 사용한다(11.4절).
3. 이벤트 식별자·버전·생산자를 검사하고 자신의 MongoDB에서 게시물을 읽는다. 이벤트에 제목·본문을 추가할 필요가 없다.
4. Post의 상주 모델로 활성 원본의 제목·본문을 임베딩하고 버전에 대응하는 ES 인덱스에 `_id=postId`로 upsert한다. ES 쓰기 성공 후 ACK한다. 동일 해시·버전이면 기존 벡터를 재사용한다.
5. 장애는 Pending 유지, `XAUTOCLAIM`, 제한된 재시도와 backoff로 복구한다. 예를 들어 5회 실패 후 `post:semantic:dead` 기록에 성공한 뒤 ACK한다. Dead Letter 기록 실패 시 원본을 ACK하지 않는다.
6. 검색 Worker의 동시성과 배치 크기를 제한한다. 초안 요청과 백그라운드 작업을 같은 추론 스케줄러에서 조정하여 사용자 요청 지연과 인덱싱 지연을 함께 관리한다. 벡터 누락 후보를 추천 요청에서 한꺼번에 재추론하지 않고 `INDEX_LAG`로 표시한다.

같은 이벤트가 다른 Stream ID로 다시 들어와도 ES 문서가 늘어나지 않아야 한다. 현재 제목·본문 수정 API는 없지만 향후 수정 기능 도입 시 단조 증가 `searchRevision`과 조건부 upsert를 함께 설계한다. `updatedAt`만으로 모든 동시 변경의 순서를 보장한다고 가정하지 않는다.

삭제·만료 원본은 Worker가 벡터를 제거하거나 검색 불가 상태로 반영한다. 이전 생성 이벤트의 재전달도 최신 MongoDB 상태를 읽어 비활성 글을 복원하지 않게 한다. 실제 상태 변경 producer 구현 시에는 Map·검색 Worker·WS 소비 계약을 함께 점검한다. 그 전에도 조회 시 MongoDB 재확인과 만료 조건이 결과 노출을 막고, 원본 대조 작업이 오래된 ES 문서를 청소한다.

### 7.2 반영 지연과 재구축

- Map 투영과 ES 투영은 독립적으로 늦어질 수 있다. ES 쓰기 ACK와 검색 가능 시각도 refresh 때문에 다를 수 있다. 통합 테스트는 고정 sleep 대신 기한이 있는 polling 또는 fixture의 `refresh=wait_for`를 사용한다.
- 초기에 warm 상태의 생성→Map 후보·ES 검색 가능 p95 5초 이내를 실험 목표로 측정한다. 직전 게시물이 두 인덱스에 나타나기 전에는 추천에서 빠질 수 있다.
- Map에 아직 없는 원본은 이 요청이 알 수 없으므로 `INDEX_LAG`로 모두 감지할 수 없다. 소비 지연·Pending·Dead Letter를 따로 감시한다. `completed`를 강제 중복 방지 근거로 사용하지 않는 이유다.
- 기존 게시물은 Post MongoDB를 keyset 방식으로 순회하여 backfill한다. Redis 보존 구간 이전의 데이터도 복구해야 하므로 Stream replay만으로 재구축하지 않는다.
- 같은 모델 버전의 인덱스 재구축은 한 작업만 허용하고 새 물리 인덱스에 수행한다. 작업 시작 Stream watermark를 기록하고 해당 버전의 기존 검색 Worker를 잠시 멈춘 뒤 원본을 스캔한다. 신규 인덱스 전용 소비자가 watermark 이후 이벤트를 따라잡은 다음 표본·건수·버전을 확인하고 해당 버전의 읽기 별칭을 원자적으로 전환한다. 모델 버전 자체의 교체는 구 버전 조회를 유지하는 11.4절 절차를 따른다.
- 재구축 동안 기존 인덱스 조회는 가능하지만 최신성은 떨어질 수 있다. 상태 지표로 부분 가용성을 표시한다. 작업 중 Stream 보존 범위를 넘거나 trim을 감지하면 전환을 중단하고 원본 대조부터 재시작한다.
- 전환 후 신규 소비자를 정상 Writer로 유지한다. 이전 인덱스는 짧은 보존 기간 후 정리한다. 모델 rollback에는 해당 임베딩 실행부·버전·임계값·인덱스를 함께 되돌려야 한다.

## 8. 로컬 Elasticsearch 테스트 계획

### 8.1 실행 구성

첫 단계는 Post 저장소의 평가 스크립트에서 실제 Node.js 임베딩 어댑터 + ES로 의미 비교 품질을 검증한다. 이후 Post API·MongoDB·Map·Redis를 연결한다. 아래 메모리는 초기 예산이며 실제 Mac의 CPU·아키텍처·Docker 메모리와 함께 측정 기록에 남긴다.

| 프로세스 | 로컬 구성 |
| --- | --- |
| Elasticsearch | 단일 노드, 9200, 컨테이너 2GiB부터 측정 |
| 임베딩 | Post 프로세스에 상주, 별도 포트 없음. 모델 로딩 전후 RSS와 추론 중 최대 메모리 측정 |
| Kibana | 선택 사항, ES와 동일 버전, 5601; 필수 테스트는 HTTP로 수행 |
| Post | 기존 호스트 프로세스 3002, MongoDB 27017 replica set, Redis 6380 |
| Map | 기존 호스트 프로세스 HTTP 3003/gRPC 50051, Cassandra 9042, Redis 6380 공유 |

전체 통합 구성은 Docker에 10–12GiB 정도를 배정하는 것으로 시작해 OOM 여부를 확인하고, 호스트에서 실행하는 Post의 모델 메모리는 별도로 확보한다. 공간이 부족하면 ES + Post 임베딩 평가와 전체 통합 시험을 나누어 실행한다. macOS arm64와 운영 Linux CPU 아키텍처의 ONNX 런타임 지원을 각각 확인한다.

별도 `compose.semantic.yaml`에는 ES·선택 Kibana를 추가한다. 모델 파일은 고정된 revision·checksum으로 준비하고 Post가 로컬 경로에서 읽는다. ES/Kibana 이미지는 구현 시작 시 지원되는 동일한 정확한 버전과 digest로 고정한다. Elastic 공식 Docker 문서에서 확인된 예시 버전은 9.5.4이며, 실제 채택 전 이미지 pull·Node 클라이언트 호환·보안 지원 상태를 다시 확인한다. `latest` 태그나 서로 다른 Kibana 버전을 사용하지 않는다. [공식 Docker 실행 문서](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-docker-basic)

추가 Compose의 ES 설정 개요:

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:${ELASTIC_VERSION:?pin-exact-version}
    environment:
      discovery.type: single-node
      xpack.security.enabled: "false"
      ES_JAVA_OPTS: -Xms1g -Xmx1g
    mem_limit: 2g
    ports:
      - "127.0.0.1:9200:9200"
    volumes:
      - post-semantic-es-data:/usr/share/elasticsearch/data
volumes:
  post-semantic-es-data:
```

이는 Compose 완성본이 아닌 설정 제안이다. ES healthcheck와 Post의 모델 준비 상태를 구현할 때 추가한다. 인증 비활성화는 localhost 개발 설정에만 적용하고 운영에는 인증·TLS·접근 제한을 적용한다. 초기 검색 경로는 ES 내부 ML 모델 배포를 사용하지 않는다. 선택 버전의 Basic 환경에서 dense_vector/script_score가 동작하는지 trial 없이 검증하여 유료 기능 의존 여부를 확인한다.

### 8.2 실행 절차와 예정 명령

**현재 가능한 기반 실행:** Post 디렉터리에서 다음을 실행한다.

```bash
docker compose up -d mongo redis
docker compose run --rm mongo-init
docker compose -f ../map-service/compose.yaml up -d cassandra
docker compose -f ../map-service/compose.yaml exec -T cassandra cqlsh < ../map-service/schema.cql
```

Cassandra health가 준비된 뒤 schema를 적용한다. Map의 `REDIS_URL=redis://localhost:6380`을 설정하고 양쪽 `.env.example`에 따라 Post ES256 개인키/Map 신뢰 공개키를 일치시킨다. Map은 기존 README의 절차대로 `pnpm dev`를 실행한다. 모델 통합 후 Post는 아래 모델·인덱스 준비까지 마친 뒤 시작한다. 실제 secret을 fixture나 문서에 저장하지 않는다.

**구현 후 추가할 실행 절차:**

```bash
# 정확한 이미지 버전을 설정한 뒤 실행한다.
docker compose -f compose.yaml -f compose.semantic.yaml up -d elasticsearch
curl -fsS 'http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=60s'

# 아래 pnpm scripts와 환경 변수는 구현 단계에서 추가할 이름이다.
pnpm semantic:model:prepare
pnpm semantic:index:init
# 별도 터미널에서 Post의 pnpm dev 실행 후 준비 완료를 확인한다.
curl -fsS http://localhost:3002/health/ready
pnpm semantic:seed
pnpm semantic:evaluate
pnpm semantic:benchmark
RUN_SEMANTIC_INTEGRATION=1 pnpm test
pnpm semantic:rebuild
```

각 script의 책임:

- `semantic:model:prepare`: 고정된 ONNX 모델·토크나이저를 다운로드하고 checksum을 검증한다. Post의 모델 경로 설정에서 참조하며 운영에서는 빌드/배포 준비 단계에 수행한다.
- `semantic:index:init`: 버전·차원 검증 후 로컬 mapping/alias 생성. 호환되지 않는 기존 인덱스를 조용히 덮어쓰지 않는다.
- `semantic:seed`: 전용 테스트 DB/Stream/인덱스에 고정 ID·상대 시각의 한국어 fixture를 적재. end-to-end 모드에서는 게시물 생성 API를 통해 Outbox→소비 흐름까지 사용한다.
- `semantic:evaluate`: 실제 고정 모델로 fixture를 임베딩하고 ES 결과·정답·지연을 비교하여 JSON/Markdown 결과를 남긴다.
- `semantic:benchmark`: Post의 실제 어댑터로 warm/cold, 입력 길이, 후보 수, 추론 동시성·스레드 수·양자화별 결과를 비교한다. 전체 API 부하 시험은 기존 게시물 API를 함께 호출한다(10.3절).
- `semantic:rebuild`: Post MongoDB backfill, watermark 이후 따라잡기, alias 교체 절차를 검증한다.

통합 테스트는 기존 Map/WS 테스트가 Stream을 삭제하는 것과 충돌하지 않도록 별도 Compose 프로젝트·저장소 설정을 사용하거나 명시적으로 직렬 실행한다. 개발자의 기존 `post:events`나 데이터를 비우지 않는다. fixture 시각은 테스트 기준 현재 시각에 상대적으로 만들어 24시간 필터 때문에 시간이 지나면 실패하는 테스트를 피한다.

수동 시연은 위치 갱신 → 사건 게시물 생성 → 두 투영 반영 대기 → 다른 표현의 초안 추천 조회 순서다.

```bash
curl -X PUT http://localhost:3003/api/v1/location \
  -H 'Content-Type: application/json' -H 'X-User-Id: 123' \
  -d '{"latitude":37.4979,"longitude":127.0276}'

# /similar는 구현 후 호출할 신규 API다.
curl -X POST http://localhost:3002/api/v1/posts/similar \
  -H 'Content-Type: application/json' -H 'X-User-Id: 123' \
  -d '{"title":"출구 앞에서 차가 부딪혔어요","content":"버스와 승용차 사고로 도로가 막힙니다.","category":"INCIDENT","latitude":37.4979,"longitude":127.0276,"radiusM":250,"limit":5}'
```

모델 파일을 준비한 뒤 Post를 시작하고 신규 준비 상태 경로 `GET /health/ready`로 모델 로딩·워밍업 완료를 확인한다. 기존 `/health/live`는 생존 확인으로 유지한다. Swagger/OpenAPI에서도 200 목록, 빈 결과, partial, 400/403/503을 재현한다. 시험 후 ES는 `docker compose -f compose.yaml -f compose.semantic.yaml stop elasticsearch`로, Post는 실행 프로세스를 종료해 중지한다. 볼륨 제거는 필수 정리 절차로 두지 않는다.

### 8.3 실제 의미 품질 데이터

최소 30개 사건 묶음, 총 200개 이상의 한국어 초안·게시물 조합으로 시작한다. 사건 ID·위치·시각·분류·동일 사건 여부를 사람이 라벨링한다. 동일 사건의 표현들이 튜닝/검증 양쪽으로 섞이지 않도록 사건 단위로 분리한다. 가능하면 두 명이 애매한 라벨을 검토한다.

| 사례 | 기대 결과 |
| --- | --- |
| “버스와 승용차가 충돌” ↔ “차 두 대 접촉사고로 길이 막힘”, 같은 현장·시각 | 상위 추천 |
| 같은 문장, 다른 동네 | Map 필터에서 제외 |
| 같은 장소·유사 문장, 며칠 전 사건 | 시간 정책으로 제외 |
| 인근에서 동시에 발생한 별개 차량 사고 | 주제 유사성만으로 동일 사건으로 평가하지 않음 |
| “불이 났다” ↔ “화재가 아니라 소방 훈련” | hard negative로 오추천 측정 |
| “공연 때문에 인파가 몰림” ↔ “교통 사고 때문에 정체” | 가까워도 서로 다른 사건 |
| 같은 사건을 INCIDENT와 TRAFFIC으로 분류 | 분류 차이로 제외하지 않음 |
| 은어·오타·띄어쓰기·한국어/영어 혼용 | 의미 모델의 실제 강건성 측정 |
| 5,000자 글의 끝에만 사건 정보 존재 | 분할·집계로 정보가 보존되는지 확인 |
| 초안 “무슨 일이에요?”, 구체 정보 없음 | 과도한 추천 비율 측정 |
| 가까운 비관련 글 200개 + 더 먼 동일 사건 | 후보 상한의 누락과 partial 표시 검증 |

비교군은 동일한 Map 후보에서의 단순 문자열/BM25 검색이다. 의미 모델을 호출하지 않는 가짜 벡터 테스트는 계약 검증에만 쓰고 의미 품질의 증거로 삼지 않는다. 품질이 부족하면 모델 교체 또는 상위 후보 reranker를 별도 실험한다. LLM 사건 추출·생성형 요약을 초기 필수 의존성으로 넣지 않는다.

### 8.4 통합·장애 검증

| 시험 | 합격 조건 |
| --- | --- |
| ES에 더 높은 점수의 범위 밖 글 존재 | Map 후보 밖 ID가 응답에 한 건도 없음 |
| Map 후보 101–200번째에 동일 사건 존재 | 최대 200개 전체를 비교하여 추천 |
| Map 후보가 200개 초과 | 반환은 최대 200개이고 truncated/partial 표시 |
| limit=1 및 동점 점수 | 최상위 한 개 반환, 거리·postId 순서로 동점 해소 |
| 후보 0개 | 임베딩/ES 호출 없이 정상 빈 결과 |
| 원본 ACTIVE→비활성, ES/Map 상태는 오래됨 | 최종 응답에서 제외 |
| 생성 이벤트 중복, Worker ES 쓰기 후 ACK 전 종료 | 재처리 후 문서 1개, Pending 회수 |
| 이벤트 미지원·손상·지속 처리 실패 | 계약에 따라 ACK 또는 Dead Letter, 실패를 무한 반복하지 않음 |
| ES 정지/임베딩 정지/Map deadline | 추천 실패를 명시. ES/임베딩 장애가 기존 생성 저장을 막지 않음 |
| Map 장애 중 생성 | 기존 위치 인가의 503 동작 유지 |
| Map만 반영/ES만 반영/refresh 지연 | 예상 누락·partial·측정 지표와 일치 |
| 서로 다른 모델 버전·차원·비정상 벡터 | 혼합 비교 거부, NaN/무한값/영벡터 검증 |
| ES 신규 빈 인덱스에서 원본 재구축 | 기존 ACTIVE 글 복원, 새 이벤트 누락 없음, alias 교체 확인 |
| 동시 추천 후 동시 생성 | 둘 다 생성될 수 있음을 확인하고 강제 중복 방지로 오해하지 않음 |
| 인증·후보 상한·입력 위조 | RPC 권한과 API 검증 우회 불가, 기존 HTTP 커서 회귀 없음 |
| 모델 로딩·워밍업 지연, 새 Post 인스턴스 시작 | 준비 전 트래픽 차단, 기존 준비된 인스턴스가 요청 처리 |
| 추론 대기열 포화·deadline 만료 | 큐 크기 제한, 만료 작업 제거, 진행 중 작업의 자원도 계속 계수 |
| v1/v2 모델 동시 배포 | 요청별 모델·인덱스·임계값 버전 일치, 인덱싱 이벤트를 두 버전 모두 수신 |

장애 주입은 ES 컨테이너 stop/start, Post 재시작·추론 어댑터 실패/지연 주입, 검색 Worker 중단·재개, 인덱스 버전 전환으로 재현한다. Map의 GEO 부분 유실·Cassandra fallback 비용은 별도 밀집 fixture로 시험한다. 다른 서비스 DB의 직접 수정은 테스트 fixture 준비에만 한정하고 제품 요청 경로에 넣지 않는다.

## 9. 합격 기준과 관측 지표

아래는 **측정 전 목표값**이다. 결과를 이 문서와 함께 검토한 후 출시 기준으로 확정한다.

- 같은 사건이 정책 범위 안에 존재하는 초안의 Hit@5(추천 5개 안에 같은 사건이 하나 이상): 90% 이상.
- 임계값을 적용한 추천의 사건 일치 precision: 85% 이상. 정답 사건이 없는 초안의 잘못된 추천 발생률: 10% 이하. 표본 수와 분모를 함께 기록한다.
- Map 후보 포함률과 포함된 후보에 대한 semantic Hit@5를 분리하고 전체 end-to-end Hit@5도 보고한다. 정책상 제외된 사례와 partial 사례를 숨기지 않는다.
- warm 상태·동시 요청 5·후보 200개의 end-to-end p95 1.5초 이하, 요청 deadline 2초. 장문과 cold start는 별도 보고한다.
- 생성→두 인덱스 검색 가능 p95 5초 이내, 후보 밖·비활성·만료 게시물 반환 0건.
- Post/Outbox 생성 지연 회귀 없음, 기존 생성·조회·참여·댓글 테스트 통과.

기록할 지표는 후보 수·상한 도달률·Map RPC 횟수·Map/임베딩/ES/MongoDB 단계별 지연·전체 p50/p95/p99·결과 수·빈 결과율·partial 비율·timeout·인덱스 누락률·소비 Pending/최장 지연/Dead Letter·모델 메모리·CPU다. 임베딩은 큐 대기·토큰화·추론·집계를 분리하고 이벤트 루프 지연, 처리량, 큐 초과 거부율, 기존 Post API 지연도 수집한다. 본문·정밀 위치·벡터·JWT를 일반 요청 로그에 남기지 않고 request ID와 정책 버전으로 추적한다.

## 10. Post 상주 모델 운영과 성능 튜닝

### 10.1 프로세스 수명주기와 cold start

운영 Post는 ECS Service의 상시 실행 task로 배포한다. 최소 실행 수를 0보다 크게 유지하고, 가용성과 트래픽 목표에 따라 여러 task를 둔다. 모델 파일은 버전·checksum을 고정하여 이미지 또는 배포 준비 단계에서 제공한다. 사용자 요청 중 모델을 다운로드하지 않는다. ECS Service는 지정된 task 수를 유지하며, scale-to-zero는 별도 설정이다. [AWS ECS Service](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_CreateService.html), [오토스케일링](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html)

```text
Post task 시작 → 모델 로딩 → 짧은/긴 샘플 워밍업 → readiness 통과
  → 요청마다 같은 모델로 추론 → 종료 시 신규 작업 접수 중단·처리 중 작업 정리
```

- 모델 로딩·워밍업 완료 전 `GET /health/ready`는 준비 안 됨을 반환한다. 로드밸런서가 이 상태를 확인한 뒤 트래픽을 보낸다. 모델과 설정 버전도 준비 검증에 포함한다.
- 배포 시 새 task가 준비될 때까지 기존 task를 유지한다. 시작 healthcheck 유예 시간과 배포 중 여유 용량은 실제 로딩 시간에 맞춘다. 유예 시간 설정만으로 워밍업 완료가 보장되지는 않는다.
- cold start는 배포·장애 복구·증설 때 발생한다. 최소 인스턴스 유지가 증설 시간을 없애지는 않으므로 급격한 트래픽 증가에 대비한 CPU·메모리 여유를 확보한다.
- 종료 시 이미 받은 사용자 요청을 제한된 시간 동안 처리하고, 끝내지 못한 이벤트는 ACK하지 않아 다음 인스턴스가 회수하도록 한다.
- 실행 중 추론 큐 포화·일시적 오류는 추천 API의 503으로 처리한다. 이때 프로세스 전체를 재시작하거나 기존 게시물 생성 경로를 닫는 식으로 장애를 확대하지 않는다.

### 10.2 속도·메모리 튜닝 순서

| 순서 | 조정 항목 | 검증 방법 |
| --- | --- | --- |
| 1 | 모델·ONNX 세션 재사용 | 반복 요청에서 로딩 횟수 증가가 없는지 확인 |
| 2 | 기존 게시물 벡터 재사용 | 추천 요청마다 후보 200개의 임베딩을 다시 계산하지 않는지 확인 |
| 3 | 추론 동시성·큐 크기 제한 | 시작값 동시성 1에서 2·4를 비교. p95·CPU·큐 대기와 기존 API 지연으로 선택 |
| 4 | ONNX CPU 스레드 수 | 컨테이너 vCPU에 맞춰 1·2·4 등 유효한 범위를 비교. 과도한 스레드 경쟁 확인 |
| 5 | 토큰화·전처리 실행 위치 | 이벤트 루프 지연이 나타나면 Post 내부의 상주 Worker Thread로 이동하여 비교 |
| 6 | FP32와 지원되는 INT8 등 양자화 | 모델 메모리·추론 시간과 한국어 Hit@5·오추천율을 함께 비교 |
| 7 | 입력 분할·배치 크기 | 짧은 글/최대 길이 글에서 품질 유지. 작은 백그라운드 배치부터 비교 |
| 8 | ES·MongoDB 요청 크기 | 최대 200개 ID만 필터링하고 필요한 필드만 조회. 최종 상태 확인의 batch 조회 사용 |

ONNX Runtime은 CPU 스레드 조정을 지원하며 과도한 thread pool 경쟁이 생길 수 있다. 실제 사용한 Node 바인딩/Transformers.js 버전에서 설정을 전달하는 방법을 확인하고 기록한다. 양자화의 효과는 모델·CPU·입력 길이에 따라 달라진다. 압축률만 보고 채택하지 않는다. [ONNX thread 관리](https://onnxruntime.ai/docs/performance/tune-performance/threading.html), [Transformers.js 양자화](https://huggingface.co/docs/transformers.js/en/guides/dtypes)

동시성 제어는 HTTP 초안 요청과 백그라운드 인덱싱을 함께 고려한다. 사용자 요청에 우선순위를 주되 인덱싱이 계속 밀리지 않도록 최소 처리 기회도 둔다. 큐 상한과 대기 시간을 넘으면 추천 요청은 빠르게 503을 반환하고, 백그라운드 이벤트는 재처리 가능한 상태로 남긴다. Event loop에서 `async`를 사용하는 것만으로 CPU 작업이 분리되지는 않는다.

요청 deadline이 지나도 ONNX native 추론이 즉시 취소된다고 가정하지 않는다. 큐에서 아직 실행되지 않은 작업은 제거하고, 이미 시작한 작업은 결과를 버리더라도 실제 완료까지 실행 슬롯을 점유한 것으로 계산한다. timeout마다 새 모델/Worker를 띄워 병렬 작업이 누적되는 구조를 만들지 않는다.

동일 초안의 반복 호출이 실제 병목이면 `embeddingVersion + contentHash` 기준의 제한된 크기·짧은 TTL 벡터 캐시를 추가로 실험한다. 검색 결과는 Map·게시물 상태의 최신성을 확인해야 하므로 초안 벡터 캐시와 구분한다. 캐시는 초기 필수 구성으로 추가하지 않는다.

### 10.3 성능 실험과 채택 기준

운영과 같은 CPU 아키텍처·vCPU·메모리 제한에서 측정한다. Mac 실험 결과를 ECS 처리량으로 그대로 환산하지 않는다. 다음 조합을 단계적으로 시험하여 병목 구간을 확인한다.

- 후보 수: 0/20/100/200개. 입력 길이: 짧은 현장 제보/일반 글/본문 5,000자.
- 요청 부하: 동시 요청 1/5/10/20에서 시작하고 예상 운영 RPS까지 일정 도착률로 증가시킨다. 포화 뒤에도 대기열이 무한 증가하지 않는지 확인한다.
- warm 상태, 프로세스 시작부터 준비까지, 새 task 증설 중 상태를 분리한다. 처리량뿐 아니라 전체 응답 p50/p95/p99와 오류·거부율을 함께 기록한다.
- 인덱싱이 없는 상태와 지속적인 `PostCreated` 소비 상태를 비교한다. 기존 생성·상세 조회 요청도 함께 실행하여 자원 경쟁을 확인한다.
- FP32/양자화 모델, 실행 동시성, 스레드 수를 한 번에 하나씩 바꾸며 동일한 데이터로 비교한다. 품질 저하가 있는 튜닝은 별도 검토 없이 채택하지 않는다.

9절의 동시 요청 5는 초기 재현 기준이다. 예상 피크 RPS·요청 길이 분포는 운영 부하 시험 전에 별도로 정하고, 목표를 버틸 여유 용량까지 확인한다. 현재 측정값이나 보장 처리량은 없다. 검증 결과물에는 모델·런타임 버전, 머신 사양, 설정, 표본 수, 지연·메모리·정확도 비교를 함께 남긴다.

## 11. 정확도 개선·오프라인 학습·모델 배포

### 11.1 학습 전 기준 성능과 데이터

모델이 Post 내부에 상주하는 것과 파인튜닝 장소는 독립적이다. 운영 프로세스는 고정된 모델로 추론하고, Python 학습 스크립트는 별도 개발/학습 환경에서 실행한다. 학습 작업은 상시 API 서버가 아니며 Post가 HTTP로 호출하지 않는다.

먼저 학습하지 않은 한국어 지원 경량 임베딩 모델의 품질을 측정하고, 제목·본문 구성·장문 집계·유사도 임계값을 검증 데이터로 조정한다. 8.3절의 최소 데이터는 초기 기준 평가용이며 파인튜닝에 충분한 양이라는 보장은 아니다. 추가 학습 데이터의 규모는 사건별 다양성과 학습 곡선을 보고 늘린다.

라벨에는 `eventGroupId`, 게시물 쌍, 같은 사건/다른 사건/판단 불가, 판단 근거를 포함한다. 실제 장소·시간·사건 정황을 확인하되 학습 입력은 운영 때 모델에 들어가는 제목·본문과 동일하게 구성한다. 다음과 같은 학습 쌍을 만든다.

| 역할 | 예시 | 기준 |
| --- | --- | --- |
| 기준 글(anchor) | 강남역 2번 출구 앞에서 버스와 승용차가 부딪혔어요 | 비교 기준 |
| 같은 사건(positive) | 2번 출구 앞 버스 접촉사고 때문에 차가 밀립니다 | 실제로 같은 사고임을 확인 |
| 다른 사건(negative) | 강남역 8번 출구에서 오토바이와 택시 사고가 났어요 | 비슷한 주제지만 다른 사고임을 확인 |

- 현재 모델이 높은 점수로 추천했지만 실제로 다른 사건인 쌍을 우선 검토한다. 같은 장소의 다른 사고, 화재와 훈련, 같은 행사의 다른 회차 같은 hard negative가 필요하다.
- 확인되지 않은 글을 일괄 오답으로 만들지 않는다. 클릭·작성 계속 등의 사용자 행동은 보조 신호이며 사건 동일성의 확정 라벨로 쓰지 않는다.
- 생성 모델의 바꿔쓰기·오타·구어체 생성은 학습 보조에만 사용한다. 실제 사건이 바뀌거나 새로운 사실이 삽입되지 않았는지 검토하며, 최종 평가에는 별도의 실제 사례를 둔다.
- 학습/검증/최종 평가 데이터를 사건 단위로 분리한다. 같은 사건의 표현 변형을 서로 다른 분할에 넣지 않고, 가능하면 이후 시점·다른 지역 사례도 평가한다.
- 텍스트에 사건을 구분할 정보가 없으면 학습으로 복원할 수 없다. “여기 사고 났어요”처럼 모호한 글은 판단 불가 사례로 관리하고 위치·시간 필터와 함께 평가한다.

### 11.2 학습 방법과 적용 순서

| 방법 | 구현 방향 | 도입 조건 |
| --- | --- | --- |
| 대조 학습 파인튜닝 | Python Sentence Transformers에서 같은 사건 쌍을 가깝게, 다른 사건을 멀게 학습. 데이터에 맞춰 MultipleNegativesRankingLoss/TripletLoss 등을 비교 | 기준 모델의 오류와 검토된 정답 쌍 확보 후 우선 실험 |
| Hard negative mining | 현재 모델의 오추천을 추출하고 사람이 검토한 뒤 재학습 데이터에 포함 | 높은 점수의 다른 사건을 구분하지 못할 때 |
| 전체 파인튜닝 또는 LoRA | 작은 모델 전체를 학습하거나 호환되는 adapter로 학습 파라미터·메모리 부담 축소 | 학습 자원과 실제 품질 비교로 선택; LoRA가 더 정확하다고 가정하지 않음 |
| 지식 증류 | 더 강한 임베딩/점수 모델의 벡터·순위를 경량 모델이 따라 학습 | 경량 모델의 속도는 유지하면서 정확도를 보완할 필요가 있을 때 |
| Reranker 학습 | 초안과 상위 후보를 함께 읽어 순위를 다시 계산하는 별도 모델 | 임베딩 개선 후에도 오추천이 남고 추가 추론 예산이 있을 때만 후속 검토 |

1차 구현의 최종 순위는 ES 벡터 유사도다. Reranker는 추가 모델과 지연을 수반하는 후속 선택지이며 현재 요청 흐름에 자동으로 포함하지 않는다. 학습 데이터·목적 함수·LoRA/증류는 조합할 수 있지만 한 번에 여러 변경을 섞지 않고 기준 결과와 비교한다.

MultipleNegativesRankingLoss처럼 배치 안의 다른 문장을 오답으로 사용하는 경우, 같은 사건의 여러 글이 서로 오답 취급되지 않도록 사건 단위 sampling 또는 적절한 다중 정답 처리를 적용한다. 중복 문장 제거만으로 사건 단위 false negative 문제가 해결되지는 않는다. 모델 접두사·pooling·정규화·긴 글 집계도 실제 추론 파이프라인과 맞춰 검증한다.

근거: [학습 개요](https://sbert.net/docs/sentence_transformer/training_overview.html), [손실 함수 선택](https://sbert.net/docs/sentence_transformer/loss_overview.html), [hard negative 도구](https://www.sbert.net/docs/package_reference/util/hard_negatives.html), [LoRA 학습](https://www.sbert.net/examples/sentence_transformer/training/peft/README.html), [지식 증류](https://sbert.net/examples/sentence_transformer/training/distillation/), [Reranker 학습](https://sbert.net/docs/cross_encoder/training_overview.html).

### 11.3 학습 결과 검증과 Node.js 변환

```text
라벨링·사건별 데이터 분리 → Python 오프라인 학습
  → 검증 데이터로 모델·임계값 선정 → 별도 최종 평가
  → ONNX 변환 → 필요시 양자화 → Post의 Node.js 어댑터로 재평가
  → 버전별 모델 패키지 생성 → ES 벡터 backfill → 준비된 Post 버전 배포
```

- 학습 loss 감소만으로 개선을 판단하지 않는다. 동일 후보 집합에서 Hit@1/Hit@5, 추천 precision, 정답 사건이 없는 초안의 오추천율을 비교하고 Map 후보 손실까지 포함한 end-to-end 결과도 별도로 보고한다.
- 모델별 점수 분포가 달라지므로 임계값은 검증 데이터에서 다시 정한다. 최종 평가 데이터를 반복적으로 임계값 튜닝에 사용하지 않는다. 판정이 어려운 사례와 각 지표의 표본 수도 기록한다.
- 학습 seed·데이터 버전·기본 모델 revision·학습 설정·최적 checkpoint를 기록한다. 과적합을 확인하며, 개선이 없으면 기준 모델을 유지한다.
- ONNX 변환 시 모델 아키텍처·연산 지원을 확인한다. LoRA를 사용했다면 지원되는 방식으로 adapter를 병합/내보내기하고, 학습 결과와 동일한 추론을 하는지 확인한다.
- Python 원본, ONNX, 양자화 모델, Node.js 어댑터 각각에서 동일 입력의 벡터 오차·검색 순위·지연을 비교한다. pooling·토크나이저 누락이나 장문 처리 차이를 확인하고 기준을 통과한 산출물만 배포한다. [사용자 모델 변환 안내](https://huggingface.co/docs/transformers.js/en/custom_usage)
- 모델 패키지는 ONNX 파일·토크나이저·설정·checksum·`embeddingVersion`·임계값 정책·평가 보고서로 구성한다. 모델을 학습하는 코드는 운영 Post 이미지의 필수 의존성으로 넣지 않는다.

### 11.4 새 모델의 벡터 재생성과 무중단 전환

1. v2 모델이 준비되면 새 ES 인덱스와 버전별 별칭 `post-semantic-v2-read`를 만든다. v1 벡터를 덮어쓰거나 v2 초안과 섞어 비교하지 않는다.
2. v1 Post가 요청과 `post-semantic-v1` 이벤트 처리를 유지하는 동안, v2 모델로 Post MongoDB 원본을 backfill한다. 이는 운영 서버와 동일 Node 어댑터를 사용하는 한시적 작업이다.
3. backfill 시작 watermark부터 v2 전용 Consumer Group `post-semantic-v2`가 이벤트를 따라잡게 한다. 서로 다른 모델 버전이 같은 그룹에서 이벤트를 나눠 받으면 두 인덱스 중 하나만 갱신될 수 있으므로 그룹을 분리한다. 작업 중 Stream 보존 구간 누락을 감시한다.
4. v2 인덱스의 원본 대조·상태·버전·소비 지연을 검증하고 v2 모델/인덱스 별칭/임계값을 묶은 Post 인스턴스를 시작한다. 워밍업과 readiness 이후 일부 트래픽부터 전환한다.
5. v1/v2가 함께 실행되는 동안 요청은 각 인스턴스에 고정된 모델과 대응 인덱스를 사용한다. 공용 별칭만 먼저 바꾸어 v1 인스턴스가 v2 벡터를 읽는 상황을 만들지 않는다.
6. v2 안정화와 rollback 기간 종료까지 v1 인덱스의 이벤트 갱신도 유지한다. 돌아갈 때는 준비된 v1 Post·인덱스·정책 묶음으로 트래픽을 전환한다. v1 갱신을 이미 중단했다면 먼저 이벤트 따라잡기/원본 대조를 완료해야 한다.
7. 구 버전 요청과 복구 필요가 없어진 후 v1 소비자·모델·인덱스를 정리한다. 동시에 두 버전을 운영하는 기간의 메모리·추론·ES 용량도 배포 예산에 포함한다.

## 12. 구현 순서와 예상 변경 파일

| 단계 | 작업 | 완료 조건 |
| --- | --- | --- |
| 0. 제품 정책 검토 | 추천 UX, 350m/24h 범위, 장애 시 작성 계속 | 정책값과 실험 범위 결정. Post 상주 모델·Map 최대 200개·ES 비교를 기준으로 진행 |
| 1. Post 내부 모델 검증 | Node 임베딩 어댑터, ES Compose/mapping, 모델 준비·한국어 fixture/평가 | 별도 PoC 서버 없이 실제 의미 품질과 로컬 자원 결과 확보 |
| 2. Map 계약 | 최대 200개 반환 RPC·truncated·ES256 권한·Post 클라이언트 | 기존 HTTP/gRPC 회귀 없이 후보를 한 번에 전달 |
| 3. 인덱싱 | Post 내부 Worker·멱등성·Pending/DLQ·backfill/rebuild | 생성 이벤트부터 검색 가능까지 복구 시험 통과 |
| 4. 추천 API | 유스케이스·입력/응답·원본 재확인·오류·OpenAPI | 후보 제한과 상태 검증·부분 결과 시험 통과 |
| 5. 전체 검증·튜닝 | 실제 Map·Post 연동, 큐/스레드/양자화, 품질/성능/장애 시험 | 9·10절 결과 보고와 출시 여부 판단 |
| 6. 공개 준비 | Gateway 인증·Rate Limit·클라이언트 UX, Post 워밍업/readiness·ES 배포 | 인증 선행 조건 충족 후 기능 플래그로 단계적 공개 |
| 7. 후속 품질 개선 | 오추천 라벨링·대조 학습·ONNX 재검증·모델 버전 전환 | 11절 기준으로 개선을 입증한 모델만 배포. 첫 출시의 필수 학습 단계는 아님 |

예상 수정/추가 대상:

- Post: `src/post/application`의 추천 유스케이스·필요 포트, `infrastructure`의 Map 조회/상주 임베딩/ES 어댑터와 백그라운드 Worker, 모델 수명주기·readiness·제한된 추론 큐, 필요한 MongoDB batch 조회, controller/input/OpenAPI/module/config, 테스트.
- Post 로컬: `compose.semantic.yaml`, 고정된 ONNX 실행 의존성·모델 manifest, model:prepare/index:init/seed/evaluate/benchmark/rebuild 스크립트, `.env.example`, `package.json`·lockfile, README.
- 학습(후속): Post 저장소의 오프라인 학습·평가·ONNX 변환 스크립트, 고정된 Python 의존성, 데이터/학습/모델 버전 manifest. 대용량 모델·데이터는 Git에 직접 넣지 않고 버전 관리되는 artifact 경로로 제공.
- Map: 신규 proto·계약 문서, `src/server.ts`·`main.ts`의 조회 서비스 등록, RPC 인증/조회 테스트. 기존 공간 판정 알고리즘은 재사용하며 성능 변경은 실측한 병목에 한정한다.
- 공통 문서: `ARCHITECTURE.md`에 Post 검색 인덱스/추론 인프라와 흐름, `docs/contracts/service-authentication.md`에 신규 RPC/API 권한, Post 이벤트 소비 계약에 검색 그룹·복구 정책.
- Gateway/클라이언트: 현재 `/api/v1/posts` 프록시를 활용하되 운영 인증과 해당 경로 빈도 제한·UI는 별도 검증한다. 이 백엔드 저장소에서 클라이언트 구현 완료를 가정하지 않는다.

구현 후 저장소 루트에서 `npm run format`, `npm run format:check`를 실행하고 무관한 포맷 diff를 제거한다. Post와 Map에서 각각 `pnpm typecheck`, `pnpm test`, `pnpm build`, 저장소 연결 후 `RUN_INTEGRATION=1 pnpm test`를 실행한다. 영향이 있는 Gateway도 해당 package의 명령으로 검증한다. Post/Map에는 현재 별도 lint script가 없으므로 존재하지 않는 `pnpm lint`를 통과했다고 보고하지 않는다. 후속 Python 학습·변환 스크립트를 추가하면 재현 가능한 환경과 검증 명령도 함께 제공한다.

기반 구현 단계에서는 실제 모델을 제외한 API·Map 후보 RPC·ES 검색·이벤트 Worker·backfill/rebuild를 구현한다. 구현 계약과 실행 제한은 `contracts/semantic-search.md` 및 README를 기준으로 한다. 일반 실행은 모델 미연결로 추천 503이며 테스트에서만 fixture 모델을 주입한다. 원래 계획의 실제 모델·한국어 품질·추론 성능 목표는 후속 단계다. 검증 결과는 `SEMANTIC_VERIFICATION.md`에 기록한다.

## 13. 선택한 구성과 남은 검토 사항

선택한 구성은 **Post 내부 모델 상주 → Map 최대 200개 후보 → Elasticsearch 벡터 비교 → 유사도순 반환**이다. 기존 게시물 벡터는 생성 후 비동기로 저장하고, 초안 벡터는 요청 시 계산한다. 운영 요청 경로에는 Python 서버를 두지 않는다.

1. **추천 후 작성 계속 허용**을 1차 범위로 채택할지. 강제 제한이 필요하면 사건 동일성 정책·동시성·오탐 이의 처리까지 별도 설계해야 한다.
2. 후보 상한 200개 안에서 추천 범위를 **350m·최근 24시간**으로 실험할지. 오래 지속되거나 넓은 사건을 어떻게 다룰지.
3. 초기 모델 후보인 다국어 E5의 ONNX 호환성·한국어 품질·장문 성능·운영 메모리와 양자화 효과가 충분한지. 기준 미달이면 동일 Post 어댑터 경계에서 모델을 재선정한다.
4. 검색 장애 또는 부분 결과에서도 사용자에게 상태를 알리고 작성을 계속 허용할지.
5. 9절 품질·지연 목표를 1차 실험 기준으로 삼을지. 미달 시 모델·후보 정책 중 어느 쪽을 수정할지는 분리 측정 결과로 결정한다.
6. 예상 피크 RPS와 허용되는 기존 Post API 지연 증가량을 얼마로 둘지. 실제 부하 측정으로 추론 동시성·큐 상한·ECS 최소 용량을 확정한다.

현재 사용자 승인 범위는 실제 모델을 제외한 연동 기반 구현이다. 다음 단계에서 실제 Node 모델의 의미 품질·실행 비용과 임계값을 평가하고, 오추천 데이터가 쌓이면 오프라인 학습을 수행한다.
