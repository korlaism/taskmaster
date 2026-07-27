import { AuthorizationError } from "../../shared/errors.js";
import type { Role, User } from "./domain.js";
import * as repo from "./repository.js";

/**
 * Every authorization decision in the app routes through here, server-side.
 * Teams surfaces (button visibility, card action sets) are a UX convenience only —
 * they are never the enforcement point.
 */
export class IdentityService {
  ensureUser = repo.upsertUser;
  getUserById = repo.getUserById;
  listEnabledUsers = repo.listEnabledUsers;
  setUserEnabled = repo.setUserEnabled;
  assignRole = repo.assignRole;
  listRoles = repo.listRoles;
  listUsersMissingExternalIdentity = repo.listUsersMissingExternalIdentity;
  getExternalAccountId = repo.getExternalAccountId;
  linkExternalIdentity = repo.linkExternalIdentity;

  async hasRole(userId: string, role: Role): Promise<boolean> {
    const roles = await repo.listRoles(userId);
    return roles.includes(role);
  }

  /** Throws AuthorizationError if the user lacks the role. Call this at the top of
   * every service method that a Teams action can trigger — not just at the UI layer. */
  async requireRole(userId: string, role: Role): Promise<void> {
    const user = await repo.getUserById(userId);
    if (!user || !user.enabled) {
      throw new AuthorizationError("User is disabled or does not exist");
    }
    if (!(await this.hasRole(userId, role))) {
      throw new AuthorizationError(`User lacks required role: ${role}`);
    }
  }

  async requireEnabled(userId: string): Promise<User> {
    const user = await repo.getUserById(userId);
    if (!user || !user.enabled) {
      throw new AuthorizationError("User is disabled or does not exist");
    }
    return user;
  }
}
