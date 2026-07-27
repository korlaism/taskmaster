import { v4 as uuidv4, v5 as uuidv5 } from "uuid";

export function newId(): string {
  return uuidv4();
}

// Deterministic namespace used to derive stable dedupe keys (e.g. one notification_job
// per organization+job_type+scheduled_for) so retried scheduling never double-inserts.
const DEDUPE_NAMESPACE = "6a6f6e6f-6e6f-4e6f-a6f6-e6f6e6f6e6f6";

export function dedupeKey(...parts: string[]): string {
  return uuidv5(parts.join("|"), DEDUPE_NAMESPACE);
}
