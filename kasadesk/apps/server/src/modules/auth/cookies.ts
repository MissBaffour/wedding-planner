import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../platform/config.ts';
import type { AuthResult } from './service.ts';

export const REFRESH_COOKIE = 'kd_rt';
const COOKIE_PATH = '/v1/auth';

export type AuthResponder = (reply: FastifyReply, r: AuthResult, status?: number) => FastifyReply;

/** Refresh token travels only in an httpOnly, SameSite=Strict cookie scoped to /v1/auth. */
export function makeAuthCookies(config: Config) {
  const set = (reply: FastifyReply, token: string) =>
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
  const clear = (reply: FastifyReply) => reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  const read = (req: FastifyRequest): string | undefined => req.cookies[REFRESH_COOKIE];
  const respond: AuthResponder = (reply, r, status = 200) => {
    set(reply, r.refreshToken);
    const { refreshToken: _omit, ...body } = r;
    return reply.status(status).send(body);
  };
  return { set, clear, read, respond };
}
