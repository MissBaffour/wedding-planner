import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool.default('false'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SYSTEM_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('kasadesk'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** A rotated refresh token may be replayed within this window (lost response on a flaky network). */
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(60),

  /** "k1:<base64 32 bytes>,k2:<base64 32 bytes>" — old keys stay to decrypt, active one encrypts. */
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),

  APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default('true'),

  /** Public base URL of this API (shown in webhook URLs and the widget snippet). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),

  // ---- Meta / WhatsApp Cloud API ----
  /** Your Meta app's secret: verifies X-Hub-Signature-256 on platform-app webhooks. Empty = platform mode disabled. */
  META_APP_SECRET: z.string().default(''),
  /** Token you type into the Meta app dashboard when registering the webhook URL. */
  META_VERIFY_TOKEN: z.string().default(''),
  /** Set to the current Graph API version from Meta's changelog. */
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  /** Skip the live Graph check when connecting a number (tests/offline dev only). */
  META_SKIP_CONNECT_CHECK: bool.default('false'),

  // ---- Web chat widget ----
  WIDGET_TOKEN_SECRET: z.string().min(32, 'WIDGET_TOKEN_SECRET must be at least 32 characters'),
  WIDGET_SCRIPT_URL: z.string().url().default('http://localhost:5174/widget.js'),
  WIDGET_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

  // ---- Media storage ----
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/media'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  /** e.g. https://<account>.r2.cloudflarestorage.com for Cloudflare R2; empty for AWS. */
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LOGIN_MAX_FAILURES_PER_EMAIL: z.coerce.number().int().positive().default(10),
  LOGIN_FAILURE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
