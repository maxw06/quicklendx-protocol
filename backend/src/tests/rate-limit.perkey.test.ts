import express from "express";
import supertest from "supertest";
import {
  perKeyRateLimiter,
  perKeyRateLimitMiddleware,
  reconciliationRateLimiter,
  reconciliationRateLimitMiddleware,
  exportRateLimiter,
  exportRateLimitMiddleware,
  createKeyedRateLimitMiddleware,
  SlidingWindowRateLimiter,
  getRateLimitPolicies,
} from "../middleware/rate-limit";
import { RateLimiterRes, RateLimiterMemory } from "rate-limiter-flexible";
import { apiKeyAuthMiddleware, optionalApiKeyAuth } from "../middleware/api-key-auth";
import { apiKeyService } from "../services/api-key-service";

/**
 * Per-API-key and per-route rate limiting tests
 */
describe("per-key rate limiting", () => {
  beforeEach(() => {
    perKeyRateLimiter.delete("key-1");
    perKeyRateLimiter.delete("key-2");
    perKeyRateLimiter.delete("api-key:key-1");
    perKeyRateLimiter.delete("api-key:key-2");
  });

  it("keys on authenticated apiKey.id when present", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: "key-1" };
      next();
    });
    app.use(perKeyRateLimitMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty("x-ratelimit-limit");
    expect(res.headers).toHaveProperty("x-ratelimit-remaining");
  });

  it("skips the per-key limiter when apiKey is absent", async () => {
    const app = express();
    app.use(perKeyRateLimitMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const consumeSpy = jest.spyOn(perKeyRateLimiter, "consume");
    const res = await supertest(app).get("/test");

    expect(res.status).toBe(200);
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();

    consumeSpy.mockRestore();
  });

  it("separates buckets for different API keys", async () => {
    const app = express();
    let keyId = "key-1";
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: keyId };
      Object.defineProperty(req, "ip", { value: "127.0.0.1", configurable: true });
      next();
    });
    app.use(perKeyRateLimitMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Consume one point for key-1
    const res1 = await supertest(app).get("/test");
    expect(res1.status).toBe(200);

    // Switch to key-2 — should have full budget
    keyId = "key-2";
    const res2 = await supertest(app).get("/test");
    expect(res2.status).toBe(200);

    // Both should have near-full remaining (999 for test budget of 1000)
    expect(Number(res1.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(998);
    expect(Number(res2.headers["x-ratelimit-remaining"])).toBeGreaterThanOrEqual(998);
  });

  it("returns 429 with Retry-After when per-key limit exceeded", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: "key-1" };
      next();
    });
    app.use(perKeyRateLimitMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const rejRes = new RateLimiterRes();
    (rejRes as any).msBeforeNext = 3000;
    (rejRes as any).remainingPoints = 0;
    (rejRes as any).consumedPoints = 1001;
    (rejRes as any).isFirstInDuration = false;

    const consumeSpy = jest.spyOn(perKeyRateLimiter, "consume");
    consumeSpy.mockRejectedValueOnce(rejRes);

    const res = await supertest(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers["retry-after"]).toBe("3");
    expect(Number(res.headers["x-ratelimit-remaining"])).toBe(0);

    consumeSpy.mockRestore();
  });

  it("calls next() on unexpected error in keyed middleware", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: "key-1" };
      next();
    });
    app.use(perKeyRateLimitMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const consumeSpy = jest.spyOn(perKeyRateLimiter, "consume");
    consumeSpy.mockRejectedValueOnce(new Error("unexpected"));

    const res = await supertest(app).get("/test");
    expect(res.status).toBe(200);

    consumeSpy.mockRestore();
  });

  it("allows exactly the configured sliding-window limit and reopens as the window rolls", async () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowRateLimiter({
      points: 2,
      duration: 1,
      clock: () => now,
    });

    await expect(limiter.consume("api-key:key-1")).resolves.toMatchObject({
      remainingPoints: 1,
    });
    await expect(limiter.consume("api-key:key-1")).resolves.toMatchObject({
      remainingPoints: 0,
    });
    await expect(limiter.consume("api-key:key-1")).rejects.toMatchObject({
      remainingPoints: 0,
      msBeforeNext: 1000,
    });

    now += 999;
    await expect(limiter.consume("api-key:key-1")).rejects.toMatchObject({
      remainingPoints: 0,
      msBeforeNext: 1,
    });

    now += 1;
    await expect(limiter.consume("api-key:key-1")).resolves.toMatchObject({
      remainingPoints: 1,
    });
  });

  it("applies per-key limiting after Bearer API key auth attaches a key id", async () => {
    const app = express();
    app.use(apiKeyAuthMiddleware);
    app.get("/protected", (_req, res) => res.json({ ok: true }));

    const originalVerify = apiKeyService.verifyApiKey;
    const originalUpdateLastUsed = apiKeyService.updateLastUsed;
    (apiKeyService as any).verifyApiKey = async () => ({
      id: "auth-key-id",
      scopes: ["bid:create"],
      created_by: "investor-1",
    });
    (apiKeyService as any).updateLastUsed = () => undefined;

    const consumeSpy = jest.spyOn(perKeyRateLimiter, "consume");
    consumeSpy.mockResolvedValueOnce({
      remainingPoints: 59,
      msBeforeNext: 60_000,
      consumedPoints: 1,
      isFirstInDuration: true,
    });

    try {
      const res = await supertest(app)
        .get("/protected")
        .set("Authorization", "Bearer qlx_test_valid");

      expect(res.status).toBe(200);
      expect(consumeSpy).toHaveBeenCalledWith("api-key:auth-key-id");
      expect(res.headers["x-ratelimit-policy"]).toBe("perKey");
    } finally {
      (apiKeyService as any).verifyApiKey = originalVerify;
      (apiKeyService as any).updateLastUsed = originalUpdateLastUsed;
      consumeSpy.mockRestore();
    }
  });

  it("leaves anonymous optional auth traffic on the global limiter only", async () => {
    const app = express();
    app.use(optionalApiKeyAuth);
    app.use(perKeyRateLimitMiddleware);
    app.get("/optional", (_req, res) => res.json({ ok: true }));

    const consumeSpy = jest.spyOn(perKeyRateLimiter, "consume");
    const res = await supertest(app).get("/optional");

    expect(res.status).toBe(200);
    expect(consumeSpy).not.toHaveBeenCalled();

    consumeSpy.mockRestore();
  });

  it("surfaces per-key sliding-window policy metadata for the status endpoint", () => {
    const policies = getRateLimitPolicies();

    expect(policies.perKey).toMatchObject({
      blockSeconds: 0,
    });
    expect(policies.perKey.headers).toEqual(
      expect.arrayContaining(["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"])
    );
  });
});

describe("reconciliation route rate limiting", () => {
  beforeEach(() => {
    reconciliationRateLimiter.delete("key-1");
    reconciliationRateLimiter.delete("127.0.0.1");
  });

  it("applies reconciliation limiter with Retry-After on 429", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: "key-1" };
      next();
    });
    app.use(reconciliationRateLimitMiddleware);
    app.get("/reports", (_req, res) => res.json({ ok: true }));

    const rejRes = new RateLimiterRes();
    (rejRes as any).msBeforeNext = 60000;
    (rejRes as any).remainingPoints = 0;

    const consumeSpy = jest.spyOn(reconciliationRateLimiter, "consume");
    consumeSpy.mockRejectedValueOnce(rejRes);

    const res = await supertest(app).get("/reports");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.headers).toHaveProperty("x-ratelimit-limit");
    expect(res.headers).toHaveProperty("x-ratelimit-remaining");

    consumeSpy.mockRestore();
  });
});

describe("export route rate limiting", () => {
  beforeEach(() => {
    exportRateLimiter.delete("key-1");
    exportRateLimiter.delete("127.0.0.1");
  });

  it("applies export limiter with Retry-After on 429", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).apiKey = { id: "key-1" };
      next();
    });
    app.use(exportRateLimitMiddleware);
    app.post("/generate", (_req, res) => res.json({ ok: true }));

    const rejRes = new RateLimiterRes();
    (rejRes as any).msBeforeNext = 120000;
    (rejRes as any).remainingPoints = 0;

    const consumeSpy = jest.spyOn(exportRateLimiter, "consume");
    consumeSpy.mockRejectedValueOnce(rejRes);

    const res = await supertest(app).post("/generate");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.headers).toHaveProperty("x-ratelimit-limit");
    expect(res.headers).toHaveProperty("x-ratelimit-remaining");

    consumeSpy.mockRestore();
  });
});

describe("createKeyedRateLimitMiddleware factory", () => {
  it("creates middleware that keys on IP when no apiKey", async () => {
    const limiter = new RateLimiterMemory({ points: 5, duration: 60 });
    const mw = createKeyedRateLimitMiddleware(limiter);
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: "192.168.1.1", configurable: true });
      next();
    });
    app.use(mw);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/test");
    expect(res.status).toBe(200);
    expect(Number(res.headers["x-ratelimit-limit"])).toBe(5);
  });
});
