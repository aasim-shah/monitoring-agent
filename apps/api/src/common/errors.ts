import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z, ZodTypeAny } from 'zod';

/** API error with a stable machine-readable code (`{ code, message, requestId }`). */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super({ code, message }, status);
  }
}

export const notFound = () => new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'Not found');

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const requestId = String(request.id);

    if (exception instanceof ApiException) {
      for (const [k, v] of Object.entries(exception.headers)) reply.header(k, v);
      return reply
        .status(exception.getStatus())
        .send({ code: exception.code, message: exception.message, requestId });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return reply
        .status(status)
        .send({ code: STATUS_CODES[status] ?? 'error', message: exception.message, requestId });
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return reply.status(500).send({ code: 'internal_error', message: 'Internal error', requestId });
  }
}

/** Validates a request body; 400 `validation_failed` names the failing fields, never their values. */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || 'body'))].join(', ');
    throw new ApiException(400, 'validation_failed', `Invalid fields: ${fields}`);
  }
  return result.data;
}
