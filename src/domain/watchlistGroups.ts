import type { UserSettings, WatchlistGroup, WatchlistMembership } from "../config.js";

export const DEFAULT_WATCHLIST_GROUP = { id: "all", name: "默认分组" };
export const MAX_WATCHLIST_GROUPS = 20;
// A virtual group: never persisted as a watchlist membership or edited manually.
export const HOLDINGS_WATCHLIST_GROUP_ID = "$holdings";

export function watchlistViewGroups(settings: UserSettings): WatchlistGroup[] {
  return [
    { id: "", name: "全部" },
    { id: HOLDINGS_WATCHLIST_GROUP_ID, name: "持仓" },
    ...settings.watchlistGroups
  ];
}

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

export function membershipGroupIds(item: WatchlistMembership): string[] {
  return item.groupIds ?? [item.groupId];
}

export function setMembershipGroups(item: WatchlistMembership, ids: string[]): void {
  item.groupIds = [...new Set(ids)];
  item.groupId = item.groupIds[0] ?? "all";
}

export function removeWatchlistGroup(settings: UserSettings, id: string): void {
  if (id === "all") return;
  settings.watchlistGroups = settings.watchlistGroups.filter((group) => group.id !== id);
  for (const item of settings.watchlist) {
    const remaining = membershipGroupIds(item).filter((groupId) => groupId !== id);
    if (!remaining.length) remaining.push("all");
    setMembershipGroups(item, remaining);
  }
}

export function visibleWatchlistCodes(settings: UserSettings, groupId = ""): string[] {
  const holdingCodes = settings.holdings.map((item) => item.securityCode);
  if (groupId === HOLDINGS_WATCHLIST_GROUP_ID) return [...new Set(holdingCodes)];
  const codes = [...settings.watchlist]
    .filter((item) => item.visible && (!groupId || membershipGroupIds(item).includes(groupId)))
    .sort((a, b) => a.order - b.order)
    .map((item) => item.securityCode);
  return groupId ? codes : [...new Set([...codes, ...holdingCodes])];
}

export interface WatchlistAction {
  code: string;
  action: "groups" | "remove-current" | "remove-all";
  groupIds?: string[];
  groupId?: string;
}

export function applyWatchlistAction(settings: UserSettings, value: unknown): UserSettings {
  if (!value || typeof value !== "object") throw new Error("自选操作无效");
  const request = value as Record<string, unknown>;
  if (
    typeof request.code !== "string" ||
    !settings.securities.some((item) => item.code === request.code)
  )
    throw new Error("股票不存在");
  const next = structuredClone(settings);
  let item = next.watchlist.find((row) => row.securityCode === request.code);
  if (request.action === "groups") {
    const ids = request.groupIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 20 ||
      ids.some(
        (id: unknown) =>
          typeof id !== "string" || !next.watchlistGroups.some((group) => group.id === id)
      )
    )
      throw new Error("请至少选择一个有效分组");
    if (!item) {
      if (next.watchlist.length >= 50) throw new Error("自选股最多50只");
      item = {
        securityCode: request.code,
        visible: true,
        order: Math.max(-1, ...next.watchlist.map((row) => row.order)) + 1,
        groupId: "all"
      };
      next.watchlist.push(item);
    }
    setMembershipGroups(item, ids as string[]);
    item.visible = true;
  } else if (request.action === "remove-current") {
    if (
      typeof request.groupId !== "string" ||
      !next.watchlistGroups.some((group) => group.id === request.groupId)
    )
      throw new Error("请选择普通分组；持仓分组由持仓自动同步");
    if (!item) throw new Error("该股票已不在当前分组");
    const ids = membershipGroupIds(item);
    if (!ids.includes(request.groupId)) throw new Error("该股票已不在当前分组");
    const remaining = ids.filter((id) => id !== request.groupId);
    if (remaining.length) setMembershipGroups(item, remaining);
    else next.watchlist = next.watchlist.filter((row) => row !== item);
  } else if (request.action === "remove-all") {
    next.watchlist = next.watchlist.filter((row) => row.securityCode !== request.code);
  } else throw new Error("自选操作无效");
  return next;
}
