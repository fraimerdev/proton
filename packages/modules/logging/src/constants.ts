export const MESSAGE_LOG_RETENTION_DAYS = 30;

// Kept as a literal, not `= MESSAGE_CACHE_DEFAULT_TTL_MS`: importing @proton/core here would
// pull drizzle-orm and ioredis into whatever browser bundle reads this. config.test.ts asserts
// the two stay equal.
export const MESSAGE_CACHE_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
