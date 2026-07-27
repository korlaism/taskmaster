/**
 * Every field here is computed from durable tables (jira_issue_events, commits,
 * pull_requests, update_submissions, qa_ticket_requests) — never from an LLM. In the
 * vertical slice the Jira/Git-derived fields are naturally zero because the fake Jira
 * adapter doesn't write jira_issue_events/commits/pull_requests rows; the SQL behind
 * them is the real metric definition from docs/06 and needs no rewrite once a real
 * adapter starts populating those tables.
 */
export interface ExecutiveSummary {
  developersExpected: number;
  submitted: number;
  missing: number;
  ticketsPicked: number;
  ticketsClosed: number;
  ticketsCreated: number;
  qaTicketsCreated: number;
  ticketsInQA: number;
  itemsPendingApproval: number;
  commitsPushed: number;
  prsOpened: number;
  prsMerged: number;
  activeBlockers: number;
}

export interface ReportingWindow {
  organizationId: string;
  windowStart: Date;
  windowEnd: Date;
}
