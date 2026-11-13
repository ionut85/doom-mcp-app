// Game sessions: the canonical state of a game is its TicStep log. Stored in
// Upstash Redis when configured (KV_REST_API_* or UPSTASH_REDIS_REST_*),
// otherwise in process memory (local dev / tests only: not shared between
// serverless instances).

import { Redis } from "@upstash/redis";
import { customAlphabet } from "nanoid";
import type { TicStep } from "@doom-player/doom-core/core";

export const PERCEPTIONS = ["vision", "state", "both"] as const;
export type Perception = (typeof PERCEPTIONS)[number];

export interface Caption {
  /** gametic when the action finished */
  tic: number;
  text: string;
  /** short description of what was done, e.g. "forward+fire ×14" */
  action: string;
}

export interface Session {
  id: string;
  skill: number;
  episode: number;
  map: number;
  perception: Perception;
  steps: TicStep[];
  /** most recent first, capped */
  captions: Caption[];
  /** 64x64-unit map cells the player has stood in (for the map's "visited" overlay) */
  visited?: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export class StaleSessionError extends Error {
  constructor(id: string) {
    super(`Session ${id} was changed by another call. Call doom_observe to get the current state, then retry.`);
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown or expired session_id ${id}. Start a new game with doom_new_game.`);
  }
}

const TTL_SECONDS = 60 * 60 * 24;
const MAX_CAPTIONS = 30;
const key = (id: string) => `doom:session:${id}`;

// URL-safe, 21 chars, unguessable.
export const newSessionId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 21);

export interface SessionStore {
  readonly kind: "redis" | "memory";
  get(id: string): Promise<Session>;
  create(s: Session): Promise<void>;
  /** Saves `s` (whose version must be expected+1) only if the stored version is still `expected`. */
  save(s: Session, expected: number): Promise<void>;
}

// Compare-and-set on the version field, atomically in Redis.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
local v = cjson.decode(cur)['version']
if tonumber(v) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

class RedisStore implements SessionStore {
  readonly kind = "redis" as const;
  constructor(private readonly redis: Redis) {}

  async get(id: string): Promise<Session> {
    const s = await this.redis.get<Session>(key(id));
    if (!s) throw new SessionNotFoundError(id);
    return s;
  }

  async create(s: Session): Promise<void> {
    await this.redis.set(key(s.id), JSON.stringify(s), { ex: TTL_SECONDS, nx: true });
  }

  async save(s: Session, expected: number): Promise<void> {
    const r = await this.redis.eval<[number, string, number], number>(CAS_SCRIPT, [key(s.id)], [expected, JSON.stringify(s), TTL_SECONDS]);
    if (r === -1) throw new SessionNotFoundError(s.id);
    if (r === 0) throw new StaleSessionError(s.id);
  }
}

class MemoryStore implements SessionStore {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, string>();

  async get(id: string): Promise<Session> {
    const s = this.m.get(id);
    if (!s) throw new SessionNotFoundError(id);
    return JSON.parse(s) as Session;
  }

  async create(s: Session): Promise<void> {
    this.m.set(s.id, JSON.stringify(s));
  }

  async save(s: Session, expected: number): Promise<void> {
    const cur = this.m.get(s.id);
    if (!cur) throw new SessionNotFoundError(s.id);
    if ((JSON.parse(cur) as Session).version !== expected) throw new StaleSessionError(s.id);
    this.m.set(s.id, JSON.stringify(s));
  }
}

export function redisFromEnv(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

let store: SessionStore | undefined;

export function sessionStore(): SessionStore {
  if (!store) {
    const redis = redisFromEnv();
    if (!redis && process.env.VERCEL_ENV === "production") {
      console.warn("[doom] No Redis configured: sessions are per-instance and will be lost.");
    }
    store = redis ? new RedisStore(redis) : new MemoryStore();
  }
  return store;
}

export function addCaption(s: Session, c: Caption): void {
  s.captions = [c, ...s.captions].slice(0, MAX_CAPTIONS);
}
