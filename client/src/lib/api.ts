import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSession } from "./session";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  forbidden: "Your role doesn't allow that.",
  not_found: "That record no longer exists.",
  invalid_input: "Some of the information entered isn't valid.",
  account_locked: "This account is locked. Ask your admin to update billing.",
  not_signed_in: "Your session has ended. Please sign in again.",
  already_enrolled: "This person is already in a sequence. End that one first.",
  do_not_contact: "This person is marked Do Not Contact.",
  sequence_has_no_steps: "Add at least one step before enrolling anyone.",
  sequence_inactive: "This sequence is inactive. Set it to Active to enroll people.",
  person_converted: "This lead was converted to a contact. Enroll the contact instead.",
  task_not_open: "This step was already completed or skipped.",
  enrollment_not_active: "This person's sequence is paused. Resume it first.",
  enrollment_ended: "This person's sequence has already ended.",
  invalid_date: "Pick a valid date.",
};

function describe(body: {
  error?: string;
  message?: string;
  issues?: { fieldErrors?: Record<string, string[]> };
}) {
  if (body.message) return body.message;
  const fields = body.issues?.fieldErrors;
  if (fields && Object.keys(fields).length > 0) {
    return Object.entries(fields)
      .map(([field, errors]) => `${field}: ${errors.join(", ")}`)
      .join("; ");
  }
  return MESSAGES[body.error ?? ""] ?? "Something went wrong. Please try again.";
}

export type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** Calls the Bagger API as the signed-in user. */
export function useApi(): Api {
  const { authHeaders } = useSession();
  return useCallback(
    async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(path, {
        method,
        headers: {
          ...(await authHeaders()),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 204) return undefined as T;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data.error ?? "error", describe(data));
      return data as T;
    },
    [authHeaders],
  );
}

export interface Me {
  user: { id: string; name: string; email: string };
  orgId: string;
  role: string;
  permissions: Record<string, string | boolean>;
  billingStatus: "active" | "locked" | "cancelled";
  /** True for the one person who owns the organization. */
  isOwner: boolean;
}

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("GET", "/api/me") });
}

export function useOrgUsers() {
  const api = useApi();
  return useQuery({ queryKey: ["users"], queryFn: () => api<OrgUser[]>("GET", "/api/users") });
}

type ObjectName = "leads" | "contacts" | "accounts" | "templates" | "sequences";

/** Mirrors the server's checks so the screens only offer what will succeed. */
export function permissionsFor(me: Me | undefined, object: ObjectName) {
  const perms = me?.permissions ?? {};
  const allows = (action: string, ownerId: string) => {
    const scope = perms[`${object}.${action}`];
    return scope === "all" || (scope === "own" && ownerId === me?.user.id);
  };
  return {
    canCreate: perms[`${object}.create`] === true,
    canEdit: (ownerId: string) => allows("edit", ownerId),
    canDelete: (ownerId: string) => allows("delete", ownerId),
    canViewHistory: perms["history.view"] === true,
  };
}

/** On/off permissions that are not tied to one record. */
export function canUse(me: Me | undefined, tool: string): boolean {
  return me?.permissions[tool] === true;
}

/** Admin screens are for people who manage the organization's settings or users. */
export function isAdmin(me: Me | undefined): boolean {
  return canUse(me, "setup.org_settings") || canUse(me, "account.users_and_roles");
}
