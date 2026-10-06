import { SimilarityUnavailableError } from '../semantic/policy.js';
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  LocationDeniedError,
  ParticipationUnavailableError,
} from '../application/errors.js';
import {
  InvalidPostError,
  PostInactiveError,
  PostNotFoundError,
} from '../domain/post.js';

@Catch(
  SimilarityUnavailableError,
  PostNotFoundError,
  PostInactiveError,
  InvalidPostError,
  ParticipationUnavailableError,
  LocationDeniedError,
)
export class PostErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const response = host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(body: unknown): void } }>();
    if (error instanceof SimilarityUnavailableError) {
      response
        .status(503)
        .json({ statusCode: 503, code: error.message, message: error.message });
      return;
    }
    const httpError =
      error instanceof PostNotFoundError
        ? new NotFoundException(error.message)
        : error instanceof PostInactiveError
          ? new ForbiddenException(error.message)
          : error instanceof InvalidPostError
            ? new BadRequestException(error.message)
            : error instanceof LocationDeniedError
              ? new ForbiddenException(error.message)
              : new ServiceUnavailableException(error.message);
    response.status(httpError.getStatus()).json(httpError.getResponse());
  }
}
