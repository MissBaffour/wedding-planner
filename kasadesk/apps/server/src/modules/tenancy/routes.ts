import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, tenantOf } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import type { AuthResponder } from '../auth/cookies.ts';
import { AcceptInvitationBody, CreateInvitationBody, type InvitationService } from './invitations.ts';
import { HoursBody, UpdateBusinessBody, UpdateMemberBody, UpdateSettingsBody, type TenancyService } from './service.ts';

const ADMINS = ['owner', 'admin'] as const;
const idParam = z.object({ id: z.string().uuid() });

export function tenancyRoutes(
  app: FastifyInstance,
  deps: { tenancy: TenancyService; invitations: InvitationService; respondAuth: AuthResponder; authRateLimit: { max: number; timeWindow: string } },
) {
  const { tenancy, invitations } = deps;

  app.get('/v1/business', async (req) => tenancy.getBusiness(tenantOf(req)));
  app.patch('/v1/business', { config: { roles: [...ADMINS] } }, async (req) =>
    tenancy.updateBusiness(tenantOf(req), parse(UpdateBusinessBody, req.body), requestMeta(req)));

  app.get('/v1/business/settings', async (req) => tenancy.getSettings(tenantOf(req)));
  app.patch('/v1/business/settings', { config: { roles: [...ADMINS] } }, async (req) =>
    tenancy.updateSettings(tenantOf(req), parse(UpdateSettingsBody, req.body), requestMeta(req)));

  app.get('/v1/business/hours', async (req) => tenancy.getHours(tenantOf(req)));
  app.put('/v1/business/hours', { config: { roles: [...ADMINS] } }, async (req) =>
    tenancy.replaceHours(tenantOf(req), parse(HoursBody, req.body), requestMeta(req)));

  app.get('/v1/members', async (req) => tenancy.listMembers(tenantOf(req)));
  app.patch('/v1/members/:id', { config: { roles: [...ADMINS] } }, async (req) =>
    tenancy.updateMember(tenantOf(req), parse(idParam, req.params).id, parse(UpdateMemberBody, req.body), requestMeta(req)));

  app.get('/v1/invitations', { config: { roles: [...ADMINS] } }, async (req) => invitations.list(tenantOf(req)));
  app.post('/v1/invitations', { config: { roles: [...ADMINS] } }, async (req, reply) =>
    reply.status(201).send(await invitations.create(tenantOf(req), parse(CreateInvitationBody, req.body), requestMeta(req))));
  app.delete('/v1/invitations/:id', { config: { roles: [...ADMINS] } }, async (req, reply) => {
    await invitations.revoke(tenantOf(req), parse(idParam, req.params).id, requestMeta(req));
    return reply.status(204).send();
  });
  app.post('/v1/invitations/accept', { config: { auth: 'none', rateLimit: deps.authRateLimit } }, async (req, reply) =>
    deps.respondAuth(reply, await invitations.accept(parse(AcceptInvitationBody, req.body), requestMeta(req)), 201));

  app.get('/v1/audit-logs', { config: { roles: [...ADMINS] } }, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().regex(/^\d+$/).optional() }), req.query);
    return tenancy.listAuditLogs(tenantOf(req), q);
  });
}
