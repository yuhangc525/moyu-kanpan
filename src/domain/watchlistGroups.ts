import type { UserSettings, WatchlistGroup } from "../config.js";

export const DEFAULT_WATCHLIST_GROUP = { id: "all", name: "默认分组" };
export const MAX_WATCHLIST_GROUPS = 20;

export function normalizeWatchlistGroups(value: unknown): WatchlistGroup[] {
  const groups: WatchlistGroup[] = [{ ...DEFAULT_WATCHLIST_GROUP }];
  if (!Array.isArray(value)) return groups;
  for (const row of value as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { id, name } = row as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      typeof name !== "string" ||
      !name.trim()
    )
      continue;
    if (id === "all") {
      groups[0]!.name = name.trim().slice(0, 16);
      continue;
    }
    if (
      groups.length >= MAX_WATCHLIST_GROUPS ||
      groups.some((group) => group.id === id || group.name === name.trim().slice(0, 16))
    )
      continue;
    groups.push({ id, name: name.trim().slice(0, 16) });
  }
  return groups;
}

export function removeWatchlistGroup(settings: UserSettings, id: string): void {
  if (id === "all") return;
  settings.watchlistGroups = settings.watchlistGroups.filter((group) => group.id !== id);
  for (const item of settings.watchlist) if (item.groupId === id) item.groupId = "all";
}

export function visibleWatchlistCodes(settings: UserSettings, groupId = ""): string[] {
  return [...settings.watchlist]
    .filter((item) => item.visible && (!groupId || item.groupId === groupId))
    .sort((a, b) => a.order - b.order)
    .map((item) => item.securityCode);
}
