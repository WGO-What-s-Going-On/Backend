import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import {
  requestContext,
  safeError,
  safePath,
  sanitizeFields,
  domainForPath,
  withLogContext,
  safeText,
  identifier,
  getLogContext,
  type LogContext,
} from './observability/logging.js';

const contexts = new WeakMap<object, LogContext>();
export function gatewayContext(request: { id: string }): LogContext {
  return (
    contexts.get(request) ?? {
      requestId: request.id,
      correlationId: request.id,
    }
  );
}
const failures = new WeakMap<object, ReturnType<typeof safeError>>();
export function requestFailure(
  request: object,
  code: string,
  message: string,
  error?: unknown,
): void {
  failures.set(request, safeError(error, code, message));
}
export function loggingOptions(service: string, level: string) {
  return {
    level,
    messageKey: 'message',
    base: {
      service,
      environment:
        process.env.DEPLOYMENT_ENV ?? process.env.NODE_ENV ?? 'development',
      version: process.env.APP_VERSION ?? 'unknown',
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    hooks: {
      logMethod(
        args: Parameters<FastifyBaseLogger['info']>,
        method: FastifyBaseLogger['info'],
      ) {
        const safeArgs = args.map((value, index) =>
          typeof value === 'string'
            ? safeText(value)
            : index > 0
              ? '[omitted]'
              : value instanceof Error
                ? {
                    error: safeError(
                      value,
                      'INTERNAL_ERROR',
                      'Operation failed.',
                    ),
                  }
                : value,
        ) as Parameters<FastifyBaseLogger['info']>;
        method.apply(this, safeArgs);
      },
    },
    formatters: {
      level(label: string) {
        return {
          severity:
            (
              {
                trace: 'DEBUG',
                debug: 'DEBUG',
                info: 'INFO',
                warn: 'WARNING',
                error: 'ERROR',
                fatal: 'CRITICAL',
              } as Record<string, string>
            )[label] ?? 'INFO',
        };
      },
      log(value: Record<string, unknown>) {
        const { error, err, ...fields } = value;
        return {
          ...sanitizeFields(getLogContext()),
          event: 'application.log',
          domain: 'lifecycle',
          outcome: error || err ? 'failure' : 'success',
          ...sanitizeFields(fields),
          ...(error &&
          typeof error === 'object' &&
          'code' in error &&
          'message' in error
            ? {
                error: {
                  code: identifier(error.code) ?? 'INTERNAL_ERROR',
                  message:
                    typeof error.message === 'string'
                      ? safeText(error.message)
                      : 'Operation failed.',
                  type: 'Error',
                  ...('retryable' in error &&
                  typeof error.retryable === 'boolean'
                    ? { retryable: error.retryable }
                    : {}),
                },
              }
            : err
              ? { error: safeError(err, 'INTERNAL_ERROR', 'Operation failed.') }
              : {}),
        };
      },
    },
    serializers: { req: () => ({}), res: () => ({}) },
  };
}
export function registerRequestLogging(app: FastifyInstance): void {
  const started = new WeakMap<object, number>();
  app.addHook('onRequest', (request, _reply, done) => {
    started.set(request, performance.now());
    const context = {
      ...requestContext({ ...request.headers, 'x-request-id': request.id }),
    };
    contexts.set(request, context);
    // Socket callbacks can run outside the request async scope. Keep validated IDs on the logger.
    request.log = request.log.child(context);
    withLogContext(context, done);
  });
  app.addHook('onResponse', async (request, reply) => {
    const path = safePath(request.routeOptions.url ?? request.url);
    if (reply.statusCode < 400 && path.startsWith('/health/')) return;
    const failed = reply.statusCode >= 400;
    const domain = domainForPath(path);
    const fields = {
      ...gatewayContext(request),
      requestId: request.id,
      domain,
      event: 'http.request.completed',
      outcome: failed ? 'failure' : 'success',
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs:
        performance.now() - (started.get(request) ?? performance.now()),
      ...(failed
        ? {
            error:
              failures.get(request) ??
              safeError(
                undefined,
                `HTTP_${reply.statusCode}`,
                'Request was rejected or could not be completed.',
              ),
          }
        : {}),
    };
    if (reply.statusCode >= 500)
      request.log.error(fields, 'HTTP request failed.');
    else if (failed) request.log.warn(fields, 'HTTP request rejected.');
    else request.log.info(fields, 'HTTP request completed.');
  });
}
