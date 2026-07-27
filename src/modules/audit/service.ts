import * as repo from "./repository.js";

export class AuditService {
  record = repo.insertAuditEvent;
  listRecent = repo.listRecentAuditEvents;
}
