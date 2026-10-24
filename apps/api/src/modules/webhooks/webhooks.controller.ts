import { Controller, Param, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators.js';
import { WebhooksService } from './webhooks.service.js';

/** `POST /webhooks/:provider/:connectionId` (spec §15): authenticated by the provider's signature only. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Public()
  @Post(':provider/:connectionId')
  async receive(
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res() reply: FastifyReply,
  ) {
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v.join(',') : String(v ?? ''),
      ]),
    );
    const out = await this.webhooks.receive({
      provider,
      connectionId,
      headers,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      requestId: String(req.id),
    });
    return reply.status(out.status).send(out.body);
  }
}
