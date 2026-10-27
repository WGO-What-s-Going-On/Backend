import cassandra from 'cassandra-driver';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SigV4AuthProvider } from 'aws-sigv4-auth-cassandra-plugin';

// 공식 서명 구현은 유지한다. 플러그인 1.0.5의 SDK v2 조회 오류는 callback으로
// 전달되지 않으므로, 갱신 가능한 SDK v3 provider로 먼저 조회하고 실패를 전달한다.
export class KeyspacesAuthProvider extends SigV4AuthProvider {
  constructor(
    private readonly region: string,
    private readonly credentials = defaultProvider(),
  ) {
    super({ region });
  }

  override newAuthenticator(
    endpoint: string,
    name: string,
  ): cassandra.auth.Authenticator {
    const credentials = this.credentials;
    const region = this.region;
    let delegate: cassandra.auth.Authenticator;
    return {
      initialResponse(callback) {
        void credentials()
          .then((value) => {
            delegate = new SigV4AuthProvider({
              region,
              accessKeyId: value.accessKeyId,
              secretAccessKey: value.secretAccessKey,
              sessionToken: value.sessionToken,
            }).newAuthenticator(endpoint, name);
            delegate.initialResponse(callback);
          })
          .catch(() =>
            callback(new Error('Keyspaces Task Role credentials unavailable')),
          );
      },
      evaluateChallenge(challenge, callback) {
        delegate.evaluateChallenge(challenge, callback);
      },
      onAuthenticationSuccess(token) {
        delegate.onAuthenticationSuccess(token);
      },
    };
  }
}
