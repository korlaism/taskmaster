export type OutboxAggregateType = "reminder" | "digest" | "jira_action" | "git_action";

export interface OutboxEvent {
  id: string;
  aggregateType: OutboxAggregateType;
  aggregateId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "done" | "dead_letter";
  attempts: number;
}
