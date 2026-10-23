# 발견사항

## [High] 부분 GEO 유실 시 실제 활성 게시물이 주변 검색에서 누락됨 — 기존 WGO-ARCH-04 재현

- 위치: services/map-service/src/post-index.ts:297
- 조건/재현: 같은 합성 좌표에 실제 Cassandra·GEO로 두 게시물을 저장 → 한 게시물의 GEO member만 제거 → 같은 좌표/150m 검색.
- 기대(완전한 주변 검색 요구): Cassandra 원본에 ACTIVE인 두 게시물 모두 반환.
- 실제: GEO에 남은 한 게시물만 반환. 코드가 유효 후보가 0개일 때만 Cassandra H3 fallback하므로 부분 손실을 감지하지 못한다. rebuild 실행 뒤 두 게시물이 반환된다.
- 재현: QA-08/integration-results.json의 `QA08 partial GEO loss omits a valid post until rebuild (documented limitation)` 1/1. 테스트의 PASS는 알려진 제한을 정확히 재현했다는 의미이며 검색 완전성 PASS가 아니다.
- 영향: Map 주변 조회 및 이 후보를 쓰는 Post 유사도 검색의 누락 가능성. 기존 문서에서 알려진 한계이며 이번 QA에서 새로 발생한 회귀가 아니다.
- 수정 방향: 검색 완전성 정책을 정하고 파생 인덱스 건강도/버전 검증과 원본 fallback 또는 재구축을 연결. 대량 파티션 pagination과 조회 비용도 WGO-ARCH-04 범위에서 함께 검증. 이번 작업은 제품 수정 없음.

## 하네스 문제와 제품 결함의 구분

Semantic 첫 실행의 InvalidCursorError code14(기대3)와 뒤따른 verified202(기대201)는 symlink된 Map dist를 Vitest가 서로 다른 모듈 identity로 로드해서 발생했다. 실제 dist를 QA 폴더에 복사하자 동일한 원본 assertion 7/7이 통과했다. 두 번째 개수 실패는 첫 번째 중단으로 후속 삭제 fixture가 실행되지 않은 파급 효과다. 최초 로그는 QA-09/integration.log, 수정 후 로그는 integration-rerun.log에 보존했다. 제품 결함으로 집계하지 않는다.
