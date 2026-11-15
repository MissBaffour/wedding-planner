import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { Errors } from '../../platform/errors.ts';

export interface AccessClaims {
  userId: string;
  businessId: string | null;
}

const AUDIENCE = 'kasadesk-api';

/**
 * Short-lived access token (default 15 min), held in memory by the PWA and sent
 * as `Authorization: Bearer`. It carries identity only; role and membership are
 * re-checked against the database on every request so revocations apply at once.
 */
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string, private readonly issuer: string, readonly ttlSeconds: number) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(c: AccessClaims): Promise<string> {
    return new SignJWT({ bid: c.businessId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.userId)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw Errors.unauthorized('invalid_token');
      const bid = payload.bid;
      return { userId: payload.sub, businessId: typeof bid === 'string' ? bid : null };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw Errors.unauthorized('token_expired');
      throw Errors.unauthorized('invalid_token');
    }
  }
}
