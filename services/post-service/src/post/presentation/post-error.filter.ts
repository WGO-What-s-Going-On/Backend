import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ParticipationUnavailableError } from '../application/errors.js';
import { InvalidPostError, PostInactiveError, PostNotFoundError } from '../domain/post.js';

@Catch(PostNotFoundError, PostInactiveError, InvalidPostError, ParticipationUnavailableError)
export class PostErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const httpError = error instanceof PostNotFoundError
      ? new NotFoundException(error.message)
      : error instanceof PostInactiveError
        ? new ForbiddenException(error.message)
        : error instanceof InvalidPostError
          ? new BadRequestException(error.message)
          : new ServiceUnavailableException(error.message);
    response.status(httpError.getStatus()).json(httpError.getResponse());
  }
}
