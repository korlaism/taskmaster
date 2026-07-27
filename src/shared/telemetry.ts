import { AsyncLocalStorage } from "node:async_hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { env } from "../config/env.js";

const correlationStorage = new AsyncLocalStorage<{ correlationId: string }>();

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run({ correlationId }, fn);
}

let sdk: NodeSDK | undefined;

/** Starts OTel instrumentation. Exporter wiring (OTLP endpoint, etc.) is deployment-specific
 * and intentionally left to standard OTEL_EXPORTER_* env vars rather than hardcoded here. */
export function startTelemetry() {
  if (sdk) return;
  sdk = new NodeSDK({ serviceName: env.OTEL_SERVICE_NAME });
  sdk.start();
}

export async function stopTelemetry() {
  await sdk?.shutdown();
}
