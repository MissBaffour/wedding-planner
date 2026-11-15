import type { z } from 'zod';
import { Errors } from '../errors.ts';

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw Errors.badRequest(
      'validation_failed',
      'Some fields are not valid.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
