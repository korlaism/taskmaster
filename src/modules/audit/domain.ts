export interface AuditEvent {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details?: Record<string, unknown>;
}
