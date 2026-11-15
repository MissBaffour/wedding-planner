import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * For webhook routes only (register inside an encapsulated plugin): keep the
 * exact bytes for signature verification, then parse JSON.
 */
export function useRawJsonBody(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch {
      const err = new Error('invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}
