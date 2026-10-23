export interface RateLimit {
  limit: number;
  windowMs: number;
}

export interface ServerConfig {
  /** Max request body in bytes. */
  bodyLimitBytes: number;
  /** Reject uploads whose createdAt is further ahead of server time than this. */
  maxClockSkewMs: number;
  rateLimits: {
    /** All requests, per client IP. */
    perIp: RateLimit;
    /** Authenticated requests, per profile. */
    perProfile: RateLimit;
    /** Profile registrations, per client IP. */
    register: RateLimit;
  };
  /** Origins allowed by CORS. Extension pages with host permission don't need CORS at all. */
  allowedOrigins: string[];
  /** Trust `X-Forwarded-For` / `X-Forwarded-Proto` (set behind Railway's proxy). */
  trustProxy: boolean;
  /** Reject requests that arrived over plain HTTP (requires trustProxy). */
  requireHttps: boolean;
}

const MINUTE = 60_000;

export const defaultConfig: ServerConfig = {
  bodyLimitBytes: 2 * 1024 * 1024,
  maxClockSkewMs: 10 * MINUTE,
  rateLimits: {
    perIp: { limit: 300, windowMs: MINUTE },
    perProfile: { limit: 120, windowMs: MINUTE },
    register: { limit: 20, windowMs: 60 * MINUTE },
  },
  allowedOrigins: [],
  trustProxy: false,
  requireHttps: false,
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const flag = (name: string) => env[name] === '1' || env[name] === 'true';
  return {
    ...defaultConfig,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: flag('TRUST_PROXY'),
    requireHttps: flag('REQUIRE_HTTPS'),
  };
}
