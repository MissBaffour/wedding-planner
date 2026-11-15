import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, tenantOf } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import type { PlanService } from './plans.ts';

export function billingRoutes(app: FastifyInstance, deps: { plans: PlanService }) {
  // Billing is always reachable, even when paused, so customers can pay to reactivate.
  app.get('/v1/billing/plans', { config: { auth: 'none' } }, async () => deps.plans.listPlans());
  app.get('/v1/billing/subscription', { config: { access: 'always' } }, async (req) => deps.plans.subscription(tenantOf(req)));
  app.post('/v1/billing/plan', { config: { access: 'always', roles: ['owner'] } }, async (req) => {
    const body = parse(z.object({ planCode: z.string().min(1).max(40) }), req.body);
    return deps.plans.choosePlanDuringTrial(tenantOf(req), body.planCode, requestMeta(req));
  });
}
