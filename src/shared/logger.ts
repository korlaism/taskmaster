import pino from "pino";
import { env } from "../config/env.js";

// Redaction list: never log token/secret-bearing fields, per the security requirements
// (external tokens, card submission secrets, webhook secrets must never reach logs).
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.encrypted_credentials",
      "*.webhookSecret",
      "*.authorization",
      "req.headers.authorization",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
