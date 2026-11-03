# PWA/FCM 실수신 검증 인계

이 저장소에서는 서버 API·mock FCM까지 검증했다. 프런트엔드 구현, 실제 Firebase 발송·기기 수신·GCP 배포는 실행하지 않았다.

1. 사용할 Firebase 프로젝트와 웹 앱 설정, HTTPS origin, VAPID 공개키, service worker 등록 범위를 확인한다. 사용자 버튼 동작으로 알림 권한을 요청하고 허용/거부를 각각 시험한다. Firebase의 [Web 설정 문서](https://firebase.google.com/docs/cloud-messaging/web/get-started)를 따른다. 현재 백엔드는 `{token,platform:"web"}` 등록 계약이다. 문서의 FID 기반 신규 등록과 기존 registration token API를 같은 값으로 취급하지 말고 실제 프런트 SDK 버전과 서버 호환성을 확인한다. 임의 문자열/FID를 유효한 FCM registration token으로 보고하지 않는다.
2. 실제 발급된 token은 Access JWT로 HTTP Gateway의 `PUT /api/v1/notifications/push-subscriptions`에 등록한다. 한 사용자 두 기기와 서로 다른 두 사용자를 준비한다. Gateway는 서비스 JWT와 사용자 claim을 생성하고 Notification이 검증한다. 원문 token·서명키·정밀 좌표를 로그에 남기지 않는다.
3. 다른 테스트 계정으로 실제 댓글/답글/공감 또는 승인된 실제 User 성과를 발생시킨다. 원본 서비스 상태와 Outbox, Redis stream ID/eventId, Notification Inbox/알림 ID, delivery 결과를 대응시킨다. 등록200, FCM SDK 성공, 실제 기기 수신은 각각 별도 결과다.
4. 포그라운드 `onMessage`, 백그라운드/닫힌 탭의 service worker 수신, OS 알림 표시, 클릭 후 actionPath/commentId 이동과 알림함 재동기화를 각각 기록한다. Firebase의 [수신 상태별 동작](https://firebase.google.com/docs/cloud-messaging/web/receive-messages)을 따른다. 서버가 notification payload를 보내므로 SDK 자동 표시와 수동 showNotification을 중복 실행하지 않는다. data.notificationId로 인앱 표시를 중복 제거한다. 서버 Web notification tag도 같은 ID를 사용하지만 외부 전송의 exactly-once 보장은 아니다.
5. iOS/iPadOS에서는 홈 화면에 추가한 웹 앱에서 사용자 동작으로 권한 요청을 시험한다. 지원 조건은 [WebKit의 Web Push 설명](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)과 실제 대상 OS/브라우저에서 확인한다.
6. token 해제·무효 token·두 기기 부분 실패, 종류별 설정 OFF, 게시글 mute, 양방향 차단, 사용자 격리, 댓글 삭제/공감 취소/종료를 시험한다. 이미 FCM에 인계되거나 기기에 표시된 Push를 서버가 회수한다고 가정하지 않는다. 전송 전 대기 작업 취소와 구분한다.
7. 주변 알림은 별도 opt-in·위치 이용 목적 동의 UI와 브라우저 위치 권한을 확인한 뒤에만 활성화한다. 신선한 위치로150m 안/밖, 본인 제외, 철회·만료·갱신과 대기 Push 취소, 기본10분 제한을 실제 기기에서 시험한다. 과거 약관이나 게시글 참여로 동의를 대신하지 않는다.
8. 서버는 기존 ADC/Workload Identity를 사용하고 대상 Firebase 프로젝트의 발송 권한을 확인한다. [FCM 서버 인증](https://firebase.google.com/docs/cloud-messaging/send/v1-api)과 [Firebase Cloud Messaging API Admin 역할](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)을 따른다. 정적 운영 서비스 계정 JSON 키를 새로 만들거나 앱에 넣는 절차가 아니다.

검증 기록에는 환경·앱/브라우저/OS 버전·테스트 시각·원본 eventId·notificationId·FCM 응답·실제 화면/클릭 결과를 남긴다. 기기 실수신이 확인되기 전에는 실제 GCP/PWA 검증 완료로 표시하지 않는다.
