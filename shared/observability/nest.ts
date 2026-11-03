import {
  HttpException,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { tap } from 'rxjs';
import {
  safeError,
  identifier,
  type LogError,
  createLogger,
  domainForPath,
  requestContext,
  safePath,
  withLogContext,
  type Severity,
} from './logging.js';

/** Framework diagnostics contain no request bodies or raw provider errors. */
export class StructuredLogger implements LoggerService {
  constructor(private readonly service: string) {}
  private emit(level: Severity, message: unknown, context?: unknown): void {
    const logger = createLogger(this.service, 'framework');
    const component =
      typeof context === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(context)
        ? context
        : undefined;
    if (level === 'ERROR' || level === 'CRITICAL') {
      logger.failure(
        'framework.error',
        message,
        'FRAMEWORK_ERROR',
        'Framework operation failed',
        { component },
      );
      return;
    }
    logger.emit(
      {
        event: 'framework.diagnostic',
        message: 'Framework diagnostic',
        outcome: 'success',
        component,
      },
      level,
    );
  }
  log(message: unknown, context?: unknown): void {
    this.emit('INFO', message, context);
  }
  error(message: unknown, _trace?: unknown, context?: unknown): void {
    this.emit('ERROR', message, context);
  }
  warn(message: unknown, context?: unknown): void {
    this.emit('WARNING', message, context);
  }
  debug(message: unknown, context?: unknown): void {
    this.emit('DEBUG', message, context);
  }
  verbose(message: unknown, context?: unknown): void {
    this.emit('DEBUG', message, context);
  }
  fatal(message: unknown, context?: unknown): void {
    this.emit('CRITICAL', message, context);
  }
}

type Request = {
  headers: Record<string, unknown>;
  method?: string;
  url?: string;
};
type Response = {
  statusCode: number;
  writableFinished: boolean;
  setHeader(name: string, value: string): void;
  once(event: string, listener: () => void): void;
};

export function installHttpLogging(
  app: INestApplication,
  service: string,
): void {
  const failures = new WeakMap<object, LogError>();
  app.useGlobalInterceptors({
    intercept(context, next) {
      if (context.getType() !== 'http') return next.handle();
      const request = context.switchToHttp().getRequest<object>();
      return next.handle().pipe(
        tap({
          error: (error: unknown) => {
            const body =
              error instanceof HttpException ? error.getResponse() : undefined;
            const responseCode =
              typeof body === 'object' && body !== null && 'code' in body
                ? identifier(body.code)
                : undefined;
            const type =
              error instanceof Error ? error.constructor.name : 'Error';
            const code =
              responseCode ??
              identifier(
                type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
              ) ??
              'INTERNAL_ERROR';
            failures.set(
              request,
              safeError(error, code, 'HTTP operation failed'),
            );
          },
        }),
      );
    },
  });
  app.use((req: Request, res: Response, next: () => void) => {
    const context = requestContext(req.headers);
    const started = performance.now();
    const path = safePath(req.url ?? '/');
    const logger = createLogger(service, domainForPath(path));
    let completed = false;
    res.setHeader('x-request-id', context.requestId ?? '');
    const finish = () =>
      withLogContext(context, () => {
        if (completed) return;
        completed = true;
        const statusCode = res.statusCode;
        const data = {
          method: req.method,
          path,
          statusCode,
          durationMs: performance.now() - started,
        };
        if (!res.writableFinished)
          logger.failure(
            'http.request.aborted',
            undefined,
            'HTTP_CONNECTION_ABORTED',
            'HTTP connection closed before response completed',
            data,
          );
        else if (statusCode >= 400)
          logger.emit({
            ...data,
            event: 'http.request.completed',
            message: 'HTTP request failed',
            outcome: 'failure',
            error:
              failures.get(req) ??
              safeError(undefined, `HTTP_${statusCode}`, 'HTTP request failed'),
          });
        else if (!/^\/(?:health|ready|live)(?:\/|$)/.test(path))
          logger.success(
            'http.request.completed',
            'HTTP request completed',
            data,
          );
      });
    res.once('finish', finish);
    res.once('close', finish);
    withLogContext(context, next);
  });
}
