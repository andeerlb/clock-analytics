import type { Permissions } from "./access";
import { rpc } from "./http";

/** One person on "Usuários e perfis". Initial admins come from the server's configuration and can't be changed here. */
export interface AppUser {
  email: string;
  initialAdmin: boolean;
  profileId: number | null;
  profileName: string;
  addedBy: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
}

export interface AccessProfile {
  id: number;
  name: string;
  /** The fixed Admin profile: everything allowed, not editable. */
  isAdmin: boolean;
  permissions: Permissions;
  userCount: number;
}

export function listAppUsers(): Promise<AppUser[]> {
  return rpc<AppUser[]>("listAppUsers");
}

export function addAppUser(email: string, profileId: number): Promise<void> {
  return rpc<void>("addAppUser", { email, profileId });
}

export function setAppUserProfile(email: string, profileId: number): Promise<void> {
  return rpc<void>("setAppUserProfile", { email, profileId });
}

export function removeAppUser(email: string): Promise<void> {
  return rpc<void>("removeAppUser", { email });
}

export function listAccessProfiles(): Promise<AccessProfile[]> {
  return rpc<AccessProfile[]>("listAccessProfiles");
}

export function createAccessProfile(name: string, permissions: Permissions): Promise<number> {
  return rpc<number>("createAccessProfile", { name, permissions });
}

export function updateAccessProfile(id: number, name: string, permissions: Permissions): Promise<void> {
  return rpc<void>("updateAccessProfile", { id, name, permissions });
}

export function deleteAccessProfile(id: number): Promise<void> {
  return rpc<void>("deleteAccessProfile", { id });
}
