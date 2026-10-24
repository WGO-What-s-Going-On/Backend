# [High] 실제 Map 후보 조회가 기본500ms deadline을 넘겨 유사 게시물 API가503으로 종료됨

- 범위: 기존 WGO-ARCH-04의 과도한 순차 조회 문제를 기본설정에서 실제 재현한 신규 실행 증거. 유사도 기능을 기본설정으로 사용하기 전 해결/설정검증이 필요하다.
- 위치: services/map-service/src/post-index.ts:367, 같은파일297; services/post-service/src/post/infrastructure/map-service-auth.ts:61; services/post-service/src/post/semantic/grpc-candidates.ts:75.
- 기대: 실제 저장소와 로컬모델이 정상이고 계약상 최대200후보를 비교하는 요청이 기본설정에서 안정적으로 완료된다.
- 재현: 원본 semantic 통합fixture가 실제 Post HTTP로201게시물을 생성·Outbox발행→Map/Cassandra/GEO·ES에투영. 실제 E5준비후 MAP_GRPC_TIMEOUT_MS를기본값500으로설정. 같은150m위치에서 POST /api/v1/posts/similar 3회 및 제품 GrpcNearbyPosts.page 직접3회호출. 별도로게시물없는좌표에서동일호출3회씩.
- 실제: 후보200 HTTP503(SIMILARITY_CHECK_UNAVAILABLE) 3/3, 506.2~508.8ms. 제품 gRPC직접호출 DEADLINE_EXCEEDED(code4) 3/3, 500.8~501.4ms. 빈GEO HTTP200 3/3,418~479ms; 빈GEO 직접RPC는2회성공(482/486ms), 1회deadline(501.9ms).
- 비교조건: 원본fixture의확장10000ms에선같은서비스/실모델로HTTP200후보60표본오류0(원시합산p99 803.3ms). 별도SLO를추측한실패가아니라제품기본deadline과구현조회비용의실제충돌이다. 로컬스토리지/호스트조건에따라빈도는달라질수있다.
- 원인 근거: Map는 page limit 적용 전 GEO의모든후보에대해location/status를순차Cassandra조회한다. 후보201이면대략402개순차read. 빈GEO도19개H3cell×16shard=304순차read. 각구간의trace span을추가수집하지않았으므로총지연기여율은아직미정이지만직접RPC의code4로모델/ES이전후보조회deadline실패를분리확인했다.
- 영향: 게시물이많은지역에서유사도검사가일관되게불가하고, 비어있는지역도deadline근처에서불안정할수있다.
- 수정 방향: 실제후보상한·페이지처리순서·Cassandra read 배치/제한동시성·emptyfallback비용을줄이고별도검색deadline예산을정한다. 단순히전역deadline을크게해위치인가까지늦추는것은영향검토가필요하다. 기본500/조정예산에서0/20/200/201후보와빈/부분유실GEO를재검증한다.
- 증거: default-deadline.json(12호출전체), default-deadline-run.log, performance.json. 재현횟수:200후보API3/3,직접RPC3/3; emptyRPC1/3.
- 하네스 진단로그의Vitest exit0/7PASS는수집이완료됐다는뜻이다. 이추가실험은응답코드를수집하는프로브이므로전체기능PASS로표시하면안되며 아래추가케이스는FAIL로분류한다.
