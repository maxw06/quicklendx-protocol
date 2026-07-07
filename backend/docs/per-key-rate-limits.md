# Per-API-Key Rate Limits

QuickLendX applies the global client-IP limiter before routing, then applies an authenticated per-API-key limiter after API key middleware has validated the caller.

## Defaults

| Policy | Default | Window | Algorithm | Key |
| --- | --- | --- | --- | --- |
| `perKey` | 60 requests | 60 seconds | Sliding window | authenticated API key id |

`RATE_LIMIT_PER_KEY_POINTS` overrides the default request budget. In `NODE_ENV=test`, the policy uses a larger budget so endpoint tests do not trip the limiter while exercising unrelated behavior.

## Runtime Behavior

- `apiKeyAuthMiddleware` verifies `Authorization: Bearer <api_key>`, attaches `req.apiKey.id`, then consumes the per-key bucket.
- The legacy `apiKeyAuth` middleware attaches a principal-specific key for admin routes before consuming the same per-key policy.
- `optionalApiKeyAuth` only consumes the per-key bucket when a valid key is present.
- Anonymous requests are not assigned a synthetic per-key bucket; they are bounded by the global client-IP limiter only.

## Headers and 429 Response

Successful authenticated requests include the active per-key limit headers:

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 2026-01-01T00:01:00.000Z
X-RateLimit-Policy: perKey
```

When a key exceeds its sliding-window budget, the API returns `429` with `Retry-After` and the standard structured error body:

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "code": "RATE_LIMIT_EXCEEDED",
    "retryAfter": 1
  }
}
```

`GET /api/v1/status` exposes public policy thresholds through `rateLimits`; it does not expose runtime bucket state, API key identifiers, remaining points, or reset timers.
