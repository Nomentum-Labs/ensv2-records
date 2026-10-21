import { Redis } from 'ioredis';

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  readonly kind: string;
}

/** Fallback when no REDIS_URL is set: bounded in-process cache (per replica, lost on restart). */
export class MemoryCache implements Cache {
  readonly kind = 'memory';
  private map = new Map<string, { v: string; exp: number }>();
  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (ttlSeconds <= 0) return;
    this.map.delete(key);
    this.map.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  async del(...keys: string[]) {
    for (const k of keys) this.map.delete(k);
  }
}

export class RedisCache implements Cache {
  readonly kind = 'redis';
  constructor(private readonly redis: Redis) {}

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (ttlSeconds > 0) await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]) {
    if (keys.length) await this.redis.del(...keys);
  }
}

/** Namespaces keys so several instances (e.g. mainnet and sepolia) can share one Redis. */
export class PrefixedCache implements Cache {
  constructor(
    private readonly inner: Cache,
    private readonly prefix: string,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  get(key: string) {
    return this.inner.get(this.prefix + key);
  }
  set(key: string, value: string, ttlSeconds: number) {
    return this.inner.set(this.prefix + key, value, ttlSeconds);
  }
  del(...keys: string[]) {
    return this.inner.del(...keys.map((k) => this.prefix + k));
  }
}

/**
 * Connects to Redis if configured. Unlike enstate, a configured-but-unreachable Redis is a
 * startup error rather than a silent switch to no caching (that is how hotbox ended up uncached).
 */
export async function createCache(redisUrl?: string, prefix = ''): Promise<Cache> {
  if (!redisUrl) return new MemoryCache();
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  await redis.ping();
  return prefix ? new PrefixedCache(new RedisCache(redis), prefix) : new RedisCache(redis);
}
