import { Request, Response, NextFunction } from "express";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";

const isTest = process.env.NODE_ENV === "test";

export type RateLimitPolicyId =
  | "global"
  | "perKey"
  | "strict"
  | "reconciliation"
  | "export";

export interface RateLimitPolicySnapshot {
  id: RateLimitPolicyId;
  scope: string;
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
  key: "client-ip" | "api-key-or-client-ip";
  headers: string[];
}

export interface RateLimitConsumeResult {
  remainingPoints: number;
  msBeforeNext: number;
  consumedPoints?: number;
  isFirstInDuration?: boolean;
}

export interface RateLimiterLike {
  points: number;
  consume(key: string): Promise<RateLimitConsumeResult>;
  delete(key: string): boolean | Promise<boolean>;
}

export interface SlidingWindowRateLimiterOptions {
  points: number;
  duration: number;
  blockDuration?: number;
  clock?: () => number;
}

export class SlidingWindowRateLimiter implements RateLimiterLike {
  public readonly points: number;
  public readonly duration: number;
  public readonly blockDuration: number;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(options: SlidingWindowRateLimiterOptions) {
    this.points = options.points;
    this.duration = options.duration;
    this.blockDuration = options.blockDuration ?? 0;
    this.clock = options.clock ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitConsumeResult> {
    const now = this.clock();
    const windowMs = this.duration * 1000;
    const cutoff = now - windowMs;
    const bucket = (this.buckets.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (bucket.length >= this.points) {
      const msBeforeNext = Math.max(1, bucket[0] + windowMs - now);
      this.buckets.set(key, bucket);
      throw {
        remainingPoints: 0,
        msBeforeNext,
        consumedPoints: bucket.length + 1,
        isFirstInDuration: false,
      };
    }

    bucket.push(now);
    this.buckets.set(key, bucket);

    return {
      remainingPoints: this.points - bucket.length,
      msBeforeNext: Math.max(1, bucket[0] + windowMs - now),
      consumedPoints: bucket.length,
      isFirstInDuration: bucket.length === 1,
    };
  }

  delete(key: string): boolean {
    return this.buckets.delete(key);
  }
}

const RATE_LIMIT_HEADERS = [
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "X-RateLimit-Policy",
];

const readPositiveInt = (
  name: string,
  fallback: number,
  testFallback: number = fallback
): number => {
  if (isTest) return testFallback;
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyId, RateLimitPolicySnapshot> = {
  global: {
    id: "global",
    scope: "all public API endpoints",
    limit: readPositiveInt("RATE_LIMIT_POINTS", 100, 1000),
    windowSeconds: 60,
    blockSeconds: 60,
    key: "client-ip",
    headers: RATE_LIMIT_HEADERS,
  },
  perKey: {
    id: "perKey",
    scope: "all API endpoints after authentication context is available",
    limit: readPositiveInt("RATE_LIMIT_PER_KEY_POINTS", 60, 1000),
    windowSeconds: 60,
    blockSeconds: 0,
    key: "api-key-or-client-ip",
    headers: RATE_LIMIT_HEADERS,
  },
  strict: {
    id: "strict",
    scope: "sensitive custom endpoints using strictRateLimitMiddleware",
    limit: readPositiveInt("RATE_LIMIT_STRICT_POINTS", 5, 100),
    windowSeconds: 60,
    blockSeconds: 300,
    key: "client-ip",
    headers: RATE_LIMIT_HEADERS,
  },
  reconciliation: {
    id: "reconciliation",
    scope: "reconciliation and monitoring routes",
    limit: readPositiveInt("RATE_LIMIT_RECONCILIATION_POINTS", 10, 100),
    windowSeconds: 60,
    blockSeconds: 120,
    key: "api-key-or-client-ip",
    headers: RATE_LIMIT_HEADERS,
  },
  export: {
    id: "export",
    scope: "data export generation and download routes",
    limit: readPositiveInt("RATE_LIMIT_EXPORT_POINTS", 5, 100),
    windowSeconds: 60,
    blockSeconds: 120,
    key: "api-key-or-client-ip",
    headers: RATE_LIMIT_HEADERS,
  },
};

export const getRateLimitPolicies = (): Record<RateLimitPolicyId, RateLimitPolicySnapshot> => ({
  global: { ...RATE_LIMIT_POLICIES.global, headers: [...RATE_LIMIT_POLICIES.global.headers] },
  perKey: { ...RATE_LIMIT_POLICIES.perKey, headers: [...RATE_LIMIT_POLICIES.perKey.headers] },
  strict: { ...RATE_LIMIT_POLICIES.strict, headers: [...RATE_LIMIT_POLICIES.strict.headers] },
  reconciliation: {
    ...RATE_LIMIT_POLICIES.reconciliation,
    headers: [...RATE_LIMIT_POLICIES.reconciliation.headers],
  },
  export: { ...RATE_LIMIT_POLICIES.export, headers: [...RATE_LIMIT_POLICIES.export.headers] },
});

/**
 * Rate limiter configuration
 * 
 * Default: 100 requests per 60 seconds (global IP)
 * Per-key: 60 requests per 60 seconds
 * Test environment: 1000 requests per 60 seconds
 */
export const rateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POLICIES.global.limit,
  duration: RATE_LIMIT_POLICIES.global.windowSeconds,
  blockDuration: RATE_LIMIT_POLICIES.global.blockSeconds,
});

/**
 * Per-API-key rate limiter
 * Applies a separate bucket for each authenticated API key.
 */
export const perKeyRateLimiter = new SlidingWindowRateLimiter({
  points: RATE_LIMIT_POLICIES.perKey.limit,
  duration: RATE_LIMIT_POLICIES.perKey.windowSeconds,
  blockDuration: RATE_LIMIT_POLICIES.perKey.blockSeconds,
});

/**
 * Reconciliation-route rate limiter (strict)
 */
export const reconciliationRateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POLICIES.reconciliation.limit,
  duration: RATE_LIMIT_POLICIES.reconciliation.windowSeconds,
  blockDuration: RATE_LIMIT_POLICIES.reconciliation.blockSeconds,
});

/**
 * Export-route rate limiter (strict)
 */
export const exportRateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POLICIES.export.limit,
  duration: RATE_LIMIT_POLICIES.export.windowSeconds,
  blockDuration: RATE_LIMIT_POLICIES.export.blockSeconds,
});

/**
 * Set rate limit headers on response
 */
const isRateLimitRejection = (value: unknown): value is RateLimitConsumeResult => {
  if (value instanceof RateLimiterRes) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RateLimitConsumeResult>;
  return typeof candidate.msBeforeNext === "number" && typeof candidate.remainingPoints === "number";
};

const getClientKey = (req: Request): string => {
  return String(req.ip || req.headers["x-forwarded-for"] || "unknown");
};

const getAuthenticatedRateLimitKey = (req: Request): string | null => {
  const apiKeyId = (req as any).apiKey?.id;
  if (typeof apiKeyId === "string" && apiKeyId.trim().length > 0) {
    return `api-key:${apiKeyId}`;
  }

  const rateLimitKey = (req as any).rateLimitKey;
  if (typeof rateLimitKey === "string" && rateLimitKey.trim().length > 0) {
    return `api-key:${rateLimitKey}`;
  }

  return null;
};

const setRateLimitHeaders = (
  res: Response,
  limiter: { points: number },
  rateLimiterRes: RateLimitConsumeResult,
  policyId: RateLimitPolicyId
) => {
  res.setHeader("X-RateLimit-Limit", limiter.points);
  res.setHeader("X-RateLimit-Remaining", rateLimiterRes.remainingPoints);
  res.setHeader("X-RateLimit-Reset", new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
  res.setHeader("X-RateLimit-Policy", policyId);
};

/**
 * Global rate limit middleware
 * 
 * Applies to all public endpoints. Returns 429 Too Many Requests if exceeded.
 * Includes Retry-After header as per security guidelines.
 */
export const rateLimitMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const ip = getClientKey(req);
  
  try {
    const rateLimiterRes = await rateLimiter.consume(String(ip));
    setRateLimitHeaders(res, rateLimiter, rateLimiterRes, "global");
    next();
  } catch (rejRes) {
    if (isRateLimitRejection(rejRes)) {
      setRateLimitHeaders(res, rateLimiter, rejRes, "global");
      res.setHeader("Retry-After", Math.ceil(rejRes.msBeforeNext / 1000));
      res.status(429).json({
        error: {
          message: "Too many requests",
          code: "RATE_LIMIT_EXCEEDED",
          retryAfter: Math.ceil(rejRes.msBeforeNext / 1000),
        },
      });
    } else {
      // Fallback for unexpected errors
      res.status(500).json({
        error: {
          message: "Internal server error during rate limiting",
          code: "RATE_LIMIT_ERROR",
        },
      });
    }
  }
};

/**
 * Factory to create specialized rate limiters for sensitive endpoints
 * (e.g., Auth, KYC, Webhooks)
 */
export const createRateLimitMiddleware = (customLimiter: RateLimiterMemory) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientKey(req);
    try {
      const rateLimiterRes = await customLimiter.consume(String(ip));
      setRateLimitHeaders(res, customLimiter, rateLimiterRes, "strict");
      next();
    } catch (rejRes) {
      if (isRateLimitRejection(rejRes)) {
        setRateLimitHeaders(res, customLimiter, rejRes, "strict");
        res.setHeader("Retry-After", Math.ceil(rejRes.msBeforeNext / 1000));
        res.status(429).json({
          error: {
            message: "Sensitive endpoint rate limit exceeded",
            code: "STRICT_RATE_LIMIT_EXCEEDED",
            retryAfter: Math.ceil(rejRes.msBeforeNext / 1000),
          },
        });
      } else {
        next(); // Fallback to next if something breaks
      }
    }
  };
};

/**
 * Factory to create rate limiters keyed on API key id when available.
 * The general per-key limiter skips anonymous traffic so the global IP limiter
 * remains the only anonymous bound. Route-specific limiters may opt into an IP
 * fallback for unauthenticated, signed-token style endpoints.
 */
export const createKeyedRateLimitMiddleware = (
  customLimiter: RateLimiterLike,
  options: {
    policyId?: RateLimitPolicyId;
    authenticatedOnly?: boolean;
  } = {}
) => {
  const policyId = options.policyId ?? "perKey";
  return async (req: Request, res: Response, next: NextFunction) => {
    const authenticatedKey = getAuthenticatedRateLimitKey(req);
    if (!authenticatedKey && options.authenticatedOnly) {
      next();
      return;
    }

    const key = authenticatedKey ?? `ip:${getClientKey(req)}`;
    try {
      const rateLimiterRes = await customLimiter.consume(String(key));
      setRateLimitHeaders(res, customLimiter, rateLimiterRes, policyId);
      next();
    } catch (rejRes) {
      if (isRateLimitRejection(rejRes)) {
        setRateLimitHeaders(res, customLimiter, rejRes, policyId);
        res.setHeader("Retry-After", Math.ceil(rejRes.msBeforeNext / 1000));
        res.status(429).json({
          error: {
            message: "Rate limit exceeded",
            code: "RATE_LIMIT_EXCEEDED",
            retryAfter: Math.ceil(rejRes.msBeforeNext / 1000),
          },
        });
      } else {
        next();
      }
    }
  };
};

/**
 * Strict rate limiter for sensitive endpoints
 * 5 requests per minute
 */
export const strictRateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POLICIES.strict.limit,
  duration: RATE_LIMIT_POLICIES.strict.windowSeconds,
  blockDuration: RATE_LIMIT_POLICIES.strict.blockSeconds,
});

export const strictRateLimitMiddleware = createRateLimitMiddleware(strictRateLimiter);

/**
 * Per-API-key rate limit middleware — layer on top of the global IP limiter.
 */
export const perKeyRateLimitMiddleware = createKeyedRateLimitMiddleware(perKeyRateLimiter, {
  policyId: "perKey",
  authenticatedOnly: true,
});

/**
 * Reconciliation-route keyed rate limit middleware.
 */
export const reconciliationRateLimitMiddleware = createKeyedRateLimitMiddleware(
  reconciliationRateLimiter,
  { policyId: "reconciliation" }
);

/**
 * Export-route keyed rate limit middleware.
 */
export const exportRateLimitMiddleware = createKeyedRateLimitMiddleware(exportRateLimiter, {
  policyId: "export",
});
