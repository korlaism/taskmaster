export type Role = "developer" | "lead" | "qa" | "administrator";

export interface User {
  id: string;
  organizationId: string;
  entraObjectId: string;
  displayName: string;
  email: string | null;
  enabled: boolean;
}
