declare module 'aws-sigv4-auth-cassandra-plugin' {
  import { auth } from 'cassandra-driver';
  export class SigV4AuthProvider implements auth.AuthProvider {
    newAuthenticator(endpoint: string, name: string): auth.Authenticator;
    constructor(options: {
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string | undefined;
    });
  }
}
