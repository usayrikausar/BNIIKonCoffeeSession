// Shared-inbox assignment rules ("first to take it"). Pure — unit tested.

export interface Member {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role?: string;
}

/** Name colleagues see: display name, else the part of the email before "@". */
export function memberName(members: Member[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.user_id === userId);
  if (!m) return null;
  return m.display_name?.trim() || m.email?.split("@")[0] || "Staf";
}

/** A chat is "held" when a person is actively handling it. */
export function heldBy(conv: { status: string; assigned_to: string | null }): string | null {
  return conv.assigned_to && (conv.status === "human" || conv.status === "needs_human") ? conv.assigned_to : null;
}

export type TakeOver = { ok: true } | { ok: false; reason: "held_by_other"; holder: string };

/** May `me` take over / reply? Someone else's chat needs an explicit force ("Ambil alih daripada X"). */
export function canTakeOver(conv: { status: string; assigned_to: string | null }, me: string, force = false): TakeOver {
  const holder = heldBy(conv);
  if (!holder || holder === me || force) return { ok: true };
  return { ok: false, reason: "held_by_other", holder };
}
