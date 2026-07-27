export interface QaTicketFormPayload {
  jiraProjectId: string;
  issueType: string;
  summary: string;
  description: string;
  severity?: string;
  component?: string;
  environment?: string;
  stepsToReproduce?: string;
  expectedResult?: string;
  actualResult?: string;
  evidenceLinks?: string[];
  relatedIssueKey?: string;
  suggestedAssigneeExternalId?: string;
}

export interface QaTicketRequest {
  id: string;
  organizationId: string;
  requesterId: string;
  jiraProjectId: string;
  issueKey: string | null;
  status: "pending" | "created" | "failed";
}
