import type { Redis } from 'ioredis';

/**
 * Fixed-window counter in Redis. Used for per-account limits that the
 * per-IP HTTP limiter cannot express (e.g. failed logins for one email
 * coming from many IPs).
 */
export class CounterLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly max: number,
    private readonly windowSeconds: number,
  ) {}

  private key(id: string) {
    return `kd:rl:${this.prefix}:${id}`;
  }

  async isBlocked(id: string): Promise<boolean> {
    const v = await this.redis.get(this.key(id));
    return v !== null && Number(v) >= this.max;
  }

  async hit(id: string): Promise<number> {
    const k = this.key(id);
    const [[, count]] = (await this.redis.multi().incr(k).expire(k, this.windowSeconds, 'NX').exec()) as [[unknown, number]];
    return count;
  }

  async reset(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }
}
