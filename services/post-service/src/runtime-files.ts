import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { modelPath, verifyModel } from './post/semantic/model-artifacts.js';

export async function validateRuntimeFiles(env = process.env) {
  if (env.NODE_ENV === 'production') {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
      throw new Error(
        'NODE_TLS_REJECT_UNAUTHORIZED must not disable TLS verification',
      );
    let uri: URL;
    try {
      uri = new URL(env.MONGODB_URI ?? '');
    } catch {
      throw new Error('MONGODB_URI is required in production');
    }
    if (
      !['mongodb:', 'mongodb+srv:'].includes(uri.protocol) ||
      uri.searchParams.get('tls') !== 'true' ||
      !uri.searchParams.get('replicaSet')
    )
      throw new Error(
        'MONGODB_URI requires tls=true and replicaSet in production',
      );
    validateTrustSource(
      env.MONGODB_TLS_CA_SOURCE,
      uri.searchParams.get('tlsCAFile'),
      'MONGODB_TLS_CA_SOURCE',
      'MONGODB_URI tlsCAFile',
    );
    for (const [key, value] of uri.searchParams)
      if (
        [
          'tlsinsecure',
          'tlsallowinvalidcertificates',
          'tlsallowinvalidhostnames',
        ].includes(key.toLowerCase()) &&
        value !== 'false'
      )
        throw new Error('MONGODB_URI must not disable TLS verification');
    if (env.SEMANTIC_ENABLED !== 'false') {
      let url: URL;
      try {
        url = new URL(env.ELASTICSEARCH_URL ?? '');
      } catch {
        throw new Error('ELASTICSEARCH_URL is required in production');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('ELASTICSEARCH_URL must be HTTPS without credentials');
      if (!env.ELASTICSEARCH_API_KEY?.trim())
        throw new Error('ELASTICSEARCH_API_KEY is required in production');
      validateTrustSource(
        env.ELASTICSEARCH_TLS_CA_SOURCE,
        env.NODE_EXTRA_CA_CERTS,
        'ELASTICSEARCH_TLS_CA_SOURCE',
        'NODE_EXTRA_CA_CERTS',
      );
    }
  }
  // Node는 잘못된 extra CA를 경고만 하고 무시하므로 앱 시작 전에 다시 검사한다.
  const mongo = env.MONGODB_URI;
  let mongoCa: string | null = null;
  if (mongo) {
    try {
      mongoCa = new URL(mongo).searchParams.get('tlsCAFile');
    } catch {
      throw new Error('MONGODB_URI must be a valid MongoDB URL');
    }
  }
  for (const [name, path] of [
    ['NODE_EXTRA_CA_CERTS', env.NODE_EXTRA_CA_CERTS],
    ['MONGODB_URI tlsCAFile', mongoCa],
  ]) {
    if (!path) continue;
    try {
      const pem = await readFile(path, 'utf8');
      const certificates = pem.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
      );
      if (!certificates?.length || /PRIVATE KEY/.test(pem)) throw new Error();
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch {
      throw new Error(
        `${name} must reference a readable PEM CA certificate bundle`,
      );
    }
  }
  if (
    env.SEMANTIC_ENABLED !== 'false' &&
    env.SEMANTIC_MODEL_ENABLED !== 'false'
  )
    await verifyModel(env.SEMANTIC_MODEL_PATH ?? modelPath());
}

function validateTrustSource(
  source: string | undefined,
  path: string | null | undefined,
  name: string,
  pathName: string,
) {
  const trust = source ?? 'file';
  if (trust !== 'file' && trust !== 'system')
    throw new Error(`${name} must be file or system`);
  if (trust === 'file' && !path?.trim())
    throw new Error(`${pathName} is required for file trust in production`);
  if (trust === 'system' && path)
    throw new Error(`${pathName} must be omitted for system trust`);
}
