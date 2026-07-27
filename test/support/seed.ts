import { env } from "../../src/config/env.js";
import { bootstrapOrganizationFromEnv } from "../../src/composition.js";
import { IdentityService } from "../../src/modules/identity/index.js";
import type { Role } from "../../src/modules/identity/index.js";

export async function seedOrganization() {
  return bootstrapOrganizationFromEnv();
}

export async function seedUser(displayName: string, roles: Role[] = ["developer"]) {
  const identity = new IdentityService();
  const user = await identity.ensureUser({
    organizationId: env.ORG_ID,
    entraObjectId: `entra-${displayName}-${Math.random().toString(36).slice(2)}`,
    displayName,
    email: `${displayName.toLowerCase()}@example.test`,
  });
  for (const role of roles) {
    await identity.assignRole(user.id, role);
  }
  return user;
}
