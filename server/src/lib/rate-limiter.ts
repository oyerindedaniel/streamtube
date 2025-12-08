import { redisRate } from "./redis";
import {
  RATE_LIMIT_UPLOAD_MAX,
  RATE_LIMIT_UPLOAD_WINDOW_MS,
  RATE_LIMIT_API_MAX,
  RATE_LIMIT_API_WINDOW_MS,
} from "./constants";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  identifier?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  total: number;
  current: number;
}

export class RateLimiter {
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = {
      identifier: "default",
      ...config,
    };
  }

  async checkLimit(userId: string, endpoint: string): Promise<RateLimitResult> {
    const key = `ratelimit:${this.config.identifier}:${endpoint}:${userId}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const pipeline = redisRate.pipeline();

    pipeline.zremrangebyscore(key, 0, windowStart);

    pipeline.zcard(key);

    pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`);

    pipeline.expire(key, Math.ceil(this.config.windowMs / 1000) + 1);

    const results = await pipeline.exec();

    if (!results) {
      throw new Error("Rate limit pipeline failed");
    }

    const requestCount = (results[1][1] as number) || 0;

    if (requestCount >= this.config.maxRequests) {
      await redisRate.zrem(key, results[2][1] as string[]);

      const oldestRequests = await redisRate.zrange(key, 0, 0, "WITHSCORES");
      const resetAt =
        oldestRequests.length > 0
          ? new Date(parseInt(oldestRequests[1]) + this.config.windowMs)
          : new Date(now + this.config.windowMs);

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        total: this.config.maxRequests,
        current: requestCount,
      };
    }

    const remaining = this.config.maxRequests - requestCount - 1;

    return {
      allowed: true,
      remaining: Math.max(0, remaining),
      resetAt: new Date(now + this.config.windowMs),
      total: this.config.maxRequests,
      current: requestCount + 1,
    };
  }

  async getRemainingRequests(
    userId: string,
    endpoint: string
  ): Promise<number> {
    const key = `ratelimit:${this.config.identifier}:${endpoint}:${userId}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    await redisRate.zremrangebyscore(key, 0, windowStart);
    const count = await redisRate.zcard(key);

    return Math.max(0, this.config.maxRequests - count);
  }

  async resetLimit(userId: string, endpoint: string): Promise<void> {
    const key = `ratelimit:${this.config.identifier}:${endpoint}:${userId}`;
    await redisRate.del(key);
  }

  getConfig(): { maxRequests: number; windowMs: number; identifier?: string } {
    return { ...this.config };
  }
}

export const uploadRateLimiter = new RateLimiter({
  identifier: "upload",
  maxRequests: RATE_LIMIT_UPLOAD_MAX,
  windowMs: RATE_LIMIT_UPLOAD_WINDOW_MS,
});

export const apiRateLimiter = new RateLimiter({
  identifier: "api",
  maxRequests: RATE_LIMIT_API_MAX,
  windowMs: RATE_LIMIT_API_WINDOW_MS,
});
