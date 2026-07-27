import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { bootstrapOrganizationFromEnv, createAppContext } from "./composition.js";
import { runOneTick } from "./runtime-tick.js";
import { childLogger } from "./shared/logger.js";
import { startTelemetry, stopTelemetry } from "./shared/telemetry.js";

const log = childLogger({ module: "worker" });
const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

async function main() {
  startTelemetry();
  await bootstrapOrganizationFromEnv();
  const ctx = createAppContext();

  log.info({ workerId, intervalMs: env.SCHEDULER_TICK_INTERVAL_MS }, "worker started");

  let stopping = false;
  const timer = setInterval(async () => {
    if (stopping) return;
    try {
      await runOneTick(ctx, workerId);
    } catch (err) {
      log.error({ err: (err as Error).message }, "scheduler tick failed");
    }
  }, env.SCHEDULER_TICK_INTERVAL_MS);

  const shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    await stopTelemetry();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error({ err: err.message }, "worker failed to start");
  process.exit(1);
});
