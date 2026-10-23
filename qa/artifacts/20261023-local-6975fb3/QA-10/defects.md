# [Medium] Push 구독의 잘못된 token/platform이 400 대신 500을 반환

위치: services/notification-service/src/push-subscription/push-subscription.service.ts:22, :24. 관련 controller.ts:63-69.

발생 조건: 로컬/test 인증 문맥 X-User-Id:1로 PUT /api/v1/notifications/push-subscriptions에 {"token":" ","platform":"web"} 또는 {"token":"synthetic-qa-token","platform":"unknown"} 전송.

기대: 유효성 오류를 HTTP400으로 반환. 실제: {"statusCode":500,"message":"Internal server error"}. 두입력 각각2/2재현. token누락은400·정상web은200 각각2/2로대조. 실제NestHTTP·DynamoLocal/Redis이며외부FCM은DI대역.

영향: 클라이언트 입력 실수가 서버장애로 집계되고 재시도·모니터링을 오도한다. 저장 전 검사에서 발생하여 본재현에서데이터손상은없다.

근거: http-validation.json/log, http-validation.mjs, notification-http-helper.mjs. 원인: controller가문자열여부만검사하고 service의범위/공백검증이일반Error를던져Nest500으로매핑. 수정방향: 경계DTO/파이프에서 nonblank token과platform enum검증하거나 명시적BadRequestException/도메인오류HTTP매핑. 제품코드는수정하지않았다.

차단판정: 로컬 전체 QA 중단 사유는아님. 공개 API의입력오류계약검증은실패이므로출시전수정권고. 데이터유실·인가우회는재현하지않았다.
