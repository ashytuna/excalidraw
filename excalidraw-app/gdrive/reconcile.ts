/**
 * Pure sync decisions, modeled after paimon.moe: whenever the Drive copy has
 * changed since we last synced (and differs from local), the user picks which
 * copy wins. Local-only changes are pushed silently.
 */

export type SyncDecision = "in-sync" | "push" | "pull" | "conflict";

export const decideSync = (opts: {
  localHash: string;
  /** null if there's no copy on Drive yet */
  remoteHash: string | null;
  /** hash both sides had at the last successful sync (null = never synced) */
  lastSyncedHash: string | null;
  /** local scene & library are empty (e.g. fresh device) */
  localIsEmpty: boolean;
}): SyncDecision => {
  const { localHash, remoteHash, lastSyncedHash, localIsEmpty } = opts;

  if (remoteHash === null) {
    return "push";
  }
  if (remoteHash === localHash) {
    return "in-sync";
  }
  // Drive unchanged since our last sync -> only local changed
  if (lastSyncedHash !== null && remoteHash === lastSyncedHash) {
    return "push";
  }
  // nothing to lose locally -> just take Drive's copy
  if (localIsEmpty) {
    return "pull";
  }
  return "conflict";
};
