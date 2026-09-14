import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { ENV } from '../config/env';

export interface MessageBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  get(key: string): Promise<string | null>;
  isRedisActive(): boolean;
}

class ResilientMessageBus implements MessageBus {
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;
  private memoryBus = new EventEmitter();
  private memoryStore = new Map<string, { value: string; expiresAt?: number }>();
  private redisConnected = false;
  private subscribedChannels = new Set<string>();

  constructor() {
    this.memoryBus.setMaxListeners(100);
    this.initRedis();
  }

  private sanitizeUrl(rawUrl: string): string {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        parsed.password = '***';
      }
      return parsed.toString();
    } catch {
      return rawUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
    }
  }

  private initRedis() {
    try {
      this.redisPub = new Redis(ENV.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) {
            return null; // Stop retrying after 3 attempts, fall back to memory
          }
          return Math.min(times * 500, 2000);
        },
      });

      this.redisPub.on('error', (err) => {
        if (this.redisConnected) {
          console.warn('⚠️ Redis pub error, switching to in-memory fallback:', err.message);
        }
        this.redisConnected = false;
      });

      this.redisPub.connect().then(() => {
        console.log('✅ Connected to Redis at', this.sanitizeUrl(ENV.REDIS_URL));
        
        // Create subscriber client with enableReadyCheck: false to prevent subscriber command restriction errors
        this.redisSub = new Redis(ENV.REDIS_URL, {
          lazyConnect: true,
          enableReadyCheck: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => {
            if (times > 3) return null;
            return Math.min(times * 500, 2000);
          },
        });

        this.redisSub.on('error', (err) => {
          if (this.redisConnected) {
            console.warn('⚠️ Redis sub error, switching to in-memory fallback:', err.message);
          }
          this.redisConnected = false;
        });

        this.redisSub.connect().then(async () => {
          // Forward Redis messages to memoryBus so existing and future subscribers receive events seamlessly
          this.redisSub!.on('message', (chan, msg) => {
            this.memoryBus.emit(chan, msg);
          });

          // Ensure default global stream is registered
          this.subscribedChannels.add('f1:stream:global');

          // Subscribe to all channels registered before connection completed
          for (const chan of this.subscribedChannels) {
            try {
              await this.redisSub!.subscribe(chan);
            } catch (err: any) {
              console.warn(`⚠️ Failed to subscribe Redis channel ${chan}:`, err?.message);
            }
          }

          // Both pub and sub are connected and synchronized
          this.redisConnected = true;
          console.log('✅ Redis Pub/Sub fully synchronized and active.');
        }).catch((err) => {
          console.warn('⚠️ Redis subscriber connection warning:', err.message);
          this.redisConnected = false;
        });
      }).catch((err) => {
        console.warn('ℹ️ Redis not reachable at', this.sanitizeUrl(ENV.REDIS_URL), '- using in-memory Pub/Sub fallback.');
        this.redisConnected = false;
      });
    } catch (err) {
      console.warn('ℹ️ Redis initialization error - using in-memory Pub/Sub fallback.');
      this.redisConnected = false;
    }
  }

  public async publish(channel: string, message: string): Promise<void> {
    if (this.redisConnected && this.redisPub) {
      try {
        await this.redisPub.publish(channel, message);
        return;
      } catch {
        // Fallback to memory if publish fails
      }
    }
    this.memoryBus.emit(channel, message);
  }

  public async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    this.subscribedChannels.add(channel);
    this.memoryBus.on(channel, callback);

    if (this.redisConnected && this.redisSub) {
      try {
        await this.redisSub.subscribe(channel);
      } catch {
        // Already registered on memoryBus
      }
    }
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.redisConnected && this.redisPub) {
      try {
        if (ttlSeconds) {
          await this.redisPub.setex(key, ttlSeconds, value);
        } else {
          await this.redisPub.set(key, value);
        }
        return;
      } catch {}
    }

    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.memoryStore.set(key, { value, expiresAt });
  }

  public async get(key: string): Promise<string | null> {
    if (this.redisConnected && this.redisPub) {
      try {
        return await this.redisPub.get(key);
      } catch {}
    }

    const item = this.memoryStore.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }
    return item.value;
  }

  public isRedisActive(): boolean {
    return this.redisConnected;
  }
}

export const messageBus = new ResilientMessageBus();
export default messageBus;
