// Per-IP rate limit for the MCP endpoint. Generous enough for viewer polling
// (~150 calls/min) plus play; meant to stop abuse of an authless endpoint.
import { Ratelimit } from "@upstash/ratelimit";
import { redisFromEnv } from "./session";

const LIMIT = 300;
const WINDOW_S = 60;

let limiter: Ratelimit | null | undefined;
const local = new Map<string, { start: number; n: number }>();

export async function rateLimit(ip: string): Promise<boolean> {
  if (limiter === undefined) {
    const redis = redisFromEnv();
    limiter = redis ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMIT, `${WINDOW_S} s`), prefix: "doom:rl" }) : null;
  }
  if (limiter) return (await limiter.limit(ip)).success;
  const now = Date.now();
  const w = local.get(ip);
  if (!w || now - w.start > WINDOW_S * 1000) {
    local.set(ip, { start: now, n: 1 });
    return true;
  }
  return ++w.n <= LIMIT;
}
