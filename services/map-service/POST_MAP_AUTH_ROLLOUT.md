# Post→Map 서비스 인증 후속작업

이 문서는 [내부 서비스 인증 계약](../../docs/contracts/service-authentication.md)의
Post→Map 전환을 운영에 적용하고, 이후 HS256을 제거하기 위한 작업 목록이다.
현재 저장소의 코드와 테스트에는 Map의 HS256·ES256 동시 검증과 Post의 ES256 서명이
구현되어 있다. **운영 배포, 운영 키 주입, 내부 gRPC TLS 확인은 완료된 것으로
간주하지 않는다.** 이 저장소에는 ECS 배포 정의가 없으므로 실제 배포 설정과
관측 결과는 운영 작업 기록에 남긴다.

## 1. 운영 배포 전 준비

- [ ] ECS [task definition의 `secrets`](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)로
      개인키를 Secrets Manager에서 Post에 주입한다. Map 공개 JWKS도 배포 설정으로
      주입한다. Secrets Manager 값 변경은 실행 중인 task에 자동 반영되지 않으므로
      키 교체 때 새 task를 배포한다.
- [ ] Map task의 보안 그룹은 [Post task의 보안 그룹에서 오는 gRPC 트래픽만](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-network.html)
      허용하도록 설계한다. 모든 서비스가 같은 보안 그룹을 공유하거나 Map 앱 포트에
      우회 경로가 있으면 이 제한을 보장할 수 없으므로 실제 ECS service의 네트워크
      설정과 연결 경로를 확인한다.
- [ ] Post 전용 P-256 키 쌍을 운영 비밀 관리 체계에서 생성한다. 개인 JWK는
      `POST_SERVICE_SIGNING_JWK`로 Post 런타임에만 주입하고, 공개 JWK는
      `MAP_SERVICE_TRUSTED_JWKS`의 `keys` 배열에 등록한다. 두 설정의 `kid`를
      일치시키고 공개키 항목의 `iss`는 `wgo-post-service`, `alg`는 `ES256`으로 둔다.
      개인키를 이미지, 저장소, 로그, 배포 작업 기록에 복사하지 않는다.
- [ ] 기존 Post 버전으로 되돌릴 수 있도록 Map과 이전 Post 버전의
      `MAP_SERVICE_JWT_SECRET` 주입을 유지한다. 새 Post 버전은 이 값을 서명에
      사용하지 않는다.
- [ ] Post↔Map 실제 운영 네트워크 구간에 TLS가 적용되는지 배포 설정과 연결
      시험으로 확인한다. [ECS Service Connect TLS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-tls.html)를
      쓰면 ECS service 설정과 Private CA로 프록시 간 구간을 암호화할 수 있다.
      이 경우 앱의 `createInsecure()`는 앱과 같은 task의 프록시 사이 연결에
      사용되며, [AWS의 검증 절차](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/verify-tls-enabled.html)로
      실제 Post→Map 연결이 프록시를 통과하는지 확인한다. Service Connect를
      사용하지 않거나 앱 포트로 직접 우회할 수 있으면 별도 TLS 구성이 필요하다.
      적용 계층, 인증서 갱신 방법, 확인 결과를 운영 작업 기록에 남긴다.
- [ ] `CheckPostCreation`과 `CheckPostParticipation`의 호출 수·성공률·
      gRPC `UNAUTHENTICATED`/`PERMISSION_DENIED`/`UNAVAILABLE`/
      `DEADLINE_EXCEEDED`를 확인할 수 있는 관측 경로를 준비한다. Post의 생성·참여
      403·503 비율도 전환 전 기준값과 비교할 수 있어야 한다. 필요한 계측이 없다면
      먼저 추가한다. 토큰과 키 값은 계측·로그에 포함하지 않는다.

보안 그룹은 연결 가능한 네트워크 범위를 제한하고 Service Connect TLS는 프록시 간
트래픽을 암호화한다. ECS task role은 컨테이너의 AWS API 권한이다. 현재 계약에서
Map이 호출 서비스를 식별하고 RPC 권한을 확인하는 수단은 서비스 JWT다. 따라서
ECS 설정을 적용해도 JWT 검증을 제거하지 않는다. 네트워크 신뢰만으로 운영하는
정책으로 변경하려면 [인증 계약](../../docs/contracts/service-authentication.md)의
신뢰 경계와 권한표를 먼저 재설계해야 한다.

## 2. 순차 배포와 확인

1. Map에 공개 JWKS와 동시 검증 버전을 먼저 배포한다. 잘못된 JWKS는 시작 시
   거부되므로 인스턴스 기동 상태를 확인한다. 기존 Post의 HS256 호출로 두 RPC가
   인증 오류 없이 위치 판정 결과를 반환하는지 확인한다. `allowed=false`도 정상
   gRPC 응답일 수 있다. 이때 Map의 HTTP 인증 경로는 전환 대상이 아니다.
2. Post에 개인 JWK와 ES256 서명 버전을 배포한다. 쓰기 요청이 허용된 검증
   환경에서 두 RPC의 생성·참여 성공, 위치 거부 403, Map 인증·장애·deadline
   오류의 503을 확인한다. 거부·장애 시 Post와 Outbox에 새 기록이 남지 않는지도
   확인한다. 운영에서 차단된 공개 쓰기 API를 이 검증을 위해 열지 않는다.
3. 두 단계마다 위 관측 지표를 배포 전 기준값과 비교하고 오류 증가 여부를
   기록한다. 인증 오류가 발생하면 `kid`·공개키 등록·발급 대상·배포 인스턴스
   버전을 비밀값을 노출하지 않는 방식으로 대조한다. 운영 호출량이 없으면
   성공률만으로 전환 완료를 판정하지 않고 검증 환경의 결과와 운영 설정을 함께
   대조한다.

Post 배포에 문제가 생기면 **Post를 기존 HS256 버전으로 먼저 되돌린다**. Map의
동시 검증과 공유 secret은 유지해야 기존 Post가 두 RPC를 계속 호출할 수 있다.
Map 동시 검증 버전 자체를 되돌려야 한다면 Post가 모두 기존 버전으로 돌아온
뒤에 진행한다. 되돌린 뒤에도 두 RPC 성공률과 Post 403·503 비율을 확인한다.

## 3. 운영 후 키 교체

정기 교체 시 새 `kid`의 공개 JWK를 Map에 먼저 추가해 이전 키와 함께 배포한다.
그다음 Post 개인 JWK와 `kid`를 바꾸고 두 RPC를 확인한다. 이전 Post 인스턴스의
배포 겹침이 끝나고 기존 토큰의 최대 수명 60초가 지난 뒤 이전 공개키를
제거한다. 개인키가 유출되면 이전 `kid`를 즉시 거부하고 새 키로 전환한다.
이 경우 기존 토큰이 아직 유효해도 실패할 수 있으므로 오류율과 재시도를
관찰한다.

## 4. HS256 제거: 인증 계약 4단계

이 단계는 위 배포의 일부로 진행하지 않는다. 모든 Post 인스턴스가 ES256으로
서명하고, 이전 버전으로 되돌릴 필요가 없어졌으며, 기존 토큰 최대 수명과
배포 겹침이 지난 것을 확인한 뒤 별도 변경으로 진행한다.

- [ ] Map의 두 RPC에서 Post용 HS256 검증 분기와 관련 테스트를 제거한다.
- [ ] Map과 Post 설정·예시·배포 비밀값에서 이 호출 관계의
      `MAP_SERVICE_JWT_SECRET` 용도를 제거하고 폐기한다.
- [ ] ES256 성공·오류 경로와 두 RPC의 권한을 다시 검증하고, 이전 HS256 토큰이
      `UNAUTHENTICATED`로 거부되는지 확인한다.
- [ ] 계약·README의 전환 기간 설명과 운영 작업 기록을 갱신한다.

Map의 `MAP_GATEWAY_JWT_SECRET`은 별도의 Gateway→Map HTTP 전환 대상이다.
Post→Map의 HS256 제거 작업에 포함하지 않는다. 실제 배포와 TLS 확인이 끝나도
다른 호출 관계의 공유 secret 제거는 인증 계약 3·4단계에 따라 각각 진행한다.
