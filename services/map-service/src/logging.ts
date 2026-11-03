import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import {
  createLogger,
  requestContext,
  safeError,
  safePath,
  withLogContext,
  getLogContext,
} from './observability/logging.js';
const log = createLogger('map-service', 'map');
export function observeHttp(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const started = performance.now();
  const context = getLogContext().requestId
    ? getLogContext()
    : requestContext(request.headers);
  response.setHeader('x-request-id', context.requestId!);
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    const path = safePath(request.url ?? '/');
    const statusCode = response.writableFinished ? response.statusCode : 499;
    if (path.startsWith('/health/') && statusCode < 400) return;
    const fields = {
      ...context,
      method: request.method,
      path,
      statusCode,
      durationMs: performance.now() - started,
    };
    if (statusCode < 400)
      log.success('http.request.completed', 'HTTP request completed.', fields);
    else
      log.emit(
        {
          ...fields,
          event: 'http.request.completed',
          message: 'HTTP request failed.',
          outcome: 'failure',
          error: safeError(
            undefined,
            `HTTP_${statusCode}`,
            'HTTP request was rejected or could not be completed.',
          ),
        },
        statusCode < 500 ? 'WARNING' : 'ERROR',
      );
  };
  response.once('finish', finish);
  response.once('close', finish);
}
export function observeRpc<Request, Response>(
  call: ServerUnaryCall<Request, Response>,
  callback: sendUnaryData<Response>,
  rpcMethod: string,
): sendUnaryData<Response> {
  const started = performance.now();
  const context = getLogContext().requestId
    ? getLogContext()
    : requestContext(call.metadata.getMap());
  return (error, value, trailer, flags) => {
    const fields = {
      ...context,
      rpcMethod,
      grpcStatus: error?.code ?? 0,
      durationMs: performance.now() - started,
    };
    if (error)
      log.failure(
        'grpc.request.completed',
        error,
        `GRPC_${error.code ?? 2}`,
        'gRPC request failed.',
        fields,
      );
    else
      log.success('grpc.request.completed', 'gRPC request completed.', fields);
    callback(error, value, trailer, flags);
  };
}

export function rpcContext<Request, Response>(
  handler: (
    call: ServerUnaryCall<Request, Response>,
    callback: sendUnaryData<Response>,
  ) => Promise<void>,
) {
  return (
    call: ServerUnaryCall<Request, Response>,
    callback: sendUnaryData<Response>,
  ) =>
    withLogContext(requestContext(call.metadata.getMap()), () =>
      handler(call, callback),
    );
}
