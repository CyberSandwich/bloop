// The launch mode (ADR 0026): preview shows today's product and open adds the account-era surfaces. The mode and the
// optional preview lockout are two settings rows, changed only from /admin. The view fails closed: a missing row or an
// unknown value is preview, and a failed read is preview with the lockout (settings.ts RESTRICTIVE).

import type { LaunchMode } from "../shared/protocol.ts";
import type { AccountConfig } from "./config.ts";
import { readSettings, type Settings } from "./settings.ts";

export interface LaunchState {
  mode: LaunchMode;
  /** Set only while the mode is preview: accounts outside ADMIN_EMAILS plus TEST_EMAILS are refused. */
  lockout: boolean;
}

/** Anything but the exact open value is preview, and the lockout counts only in preview. */
export function launchOf(settings: Settings): LaunchState {
  if (settings.launch_mode === "open") return { mode: "open", lockout: false };
  return { mode: "preview", lockout: settings.preview_lockout === "1" };
}

/** The mode for this request; `fresh` for a step that creates state. */
export async function launchState(env: { DB: unknown }, options: { fresh?: boolean } = {}): Promise<LaunchState> {
  return launchOf(await readSettings(env, options));
}

/**
 * Whether the lockout lets this identity act. `emailNorm` is null for an Entra user, who is never a member of the
 * invite-only product. Without the lockout every member passes.
 */
export function admitted(
  state: LaunchState,
  account: Pick<AccountConfig, "adminEmails" | "testEmails">,
  emailNorm: string | null,
): boolean {
  if (emailNorm === null) return false;
  if (!state.lockout) return true;
  return account.adminEmails.has(emailNorm) || account.testEmails.has(emailNorm);
}
