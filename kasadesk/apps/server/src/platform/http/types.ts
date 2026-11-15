import type { MemberRole, SubscriptionStatus } from '../db/schema.ts';
import type { AccessLevel, RouteAccess } from '../../modules/billing/subscription.ts';

export interface AuthState {
  userId: string;
  businessId: string | null;
}

export interface TenantState {
  userId: string;
  businessId: string;
  membershipId: string;
  role: MemberRole;
  planCode: string;
  status: SubscriptionStatus;
  accessLevel: AccessLevel;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 'none' public, 'user' any logged-in user, 'tenant' (default) member of the selected business */
    auth?: 'none' | 'user' | 'tenant';
    /** Subscription access the route needs. Default: GET/HEAD => 'read', else 'write'. */
    access?: RouteAccess;
    /** Roles allowed. Default: all roles. */
    roles?: MemberRole[];
    /** Cookie-authenticated endpoint: require the anti-CSRF header. */
    csrf?: boolean;
  }
  interface FastifyRequest {
    auth: AuthState | null;
    tenant: TenantState | null;
  }
}

export {};
