import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, tenantOf } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import { ConnectWhatsAppBody, UpdateWebchatBody, WebchatBody, type ChannelService } from './service.ts';

const ADMINS = ['owner', 'admin'] as const;
const idParam = z.object({ id: z.string().uuid() });

export function channelRoutes(app: FastifyInstance, deps: { channels: ChannelService }) {
  const { channels } = deps;
  app.get('/v1/channels', async (req) => channels.list(tenantOf(req)));
  app.post('/v1/channels/whatsapp', { config: { roles: [...ADMINS] } }, async (req, reply) =>
    reply.status(201).send(await channels.connectWhatsApp(tenantOf(req), parse(ConnectWhatsAppBody, req.body), requestMeta(req))));
  app.post('/v1/channels/webchat', { config: { roles: [...ADMINS] } }, async (req, reply) =>
    reply.status(201).send(await channels.connectWebchat(tenantOf(req), parse(WebchatBody, req.body), requestMeta(req))));
  app.patch('/v1/channels/:id/webchat', { config: { roles: [...ADMINS] } }, async (req) =>
    channels.updateWebchat(tenantOf(req), parse(idParam, req.params).id, parse(UpdateWebchatBody, req.body), requestMeta(req)));
  app.delete('/v1/channels/:id', { config: { roles: [...ADMINS] } }, async (req, reply) => {
    await channels.disconnect(tenantOf(req), parse(idParam, req.params).id, requestMeta(req));
    return reply.status(204).send();
  });
  app.get('/v1/channels/:id/templates', async (req) => channels.listTemplates(tenantOf(req), parse(idParam, req.params).id));
  app.post('/v1/channels/:id/templates/sync', { config: { roles: [...ADMINS] } }, async (req, reply) => {
    await channels.requestTemplateSync(tenantOf(req), parse(idParam, req.params).id);
    return reply.status(202).send({ ok: true });
  });
}
