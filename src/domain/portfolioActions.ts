import type { Security, UserSettings, WatchlistMembership } from "../config.js";
import { applyHoldingEdit } from "./holdingEdit.js";
import { membershipGroupIds, setMembershipGroups } from "./watchlistGroups.js";

export type PortfolioAction =
  | { action: "add"; security: Security; quantity: number; costPrice: number }
  | { action: "reorder"; kind: "holdings" | "watchlist"; code: string; targetCode: string }
  | { action: "undo"; token: string };

export interface PortfolioResult {
  settings: UserSettings;
  undoToken?: string;
}

export function applyPortfolioAction(settings: UserSettings, value: unknown): UserSettings {
  if (!value || typeof value !== "object") throw new Error("操作无效");
  const request = value as Record<string, unknown>;
  const next = structuredClone(settings);
  if (request.action === "add") {
    const security = request.security as Security | undefined;
    if (
      !security ||
      typeof security.code !== "string" ||
      !/^\d{6}$/.test(security.code) ||
      !["SH", "SZ", "BJ"].includes(security.market) ||
      typeof security.name !== "string" ||
      !security.name.trim() ||
      security.name.length > 80
    )
      throw new Error("股票信息无效");
    if (next.holdings.some((item) => item.securityCode === security.code))
      throw new Error("该股票已有持仓，请直接编辑数量和成本");
    if (!next.securities.some((item) => item.code === security.code))
      next.securities.push({
        code: security.code,
        market: security.market,
        name: security.name,
        alias: ""
      });
    const fields = { quantity: 1, costPrice: 1, groupId: "all", note: "" };
    next.holdings.push({
      securityCode: security.code,
      ...fields,
      alertRules: {
        enabled: false,
        stopLossPrice: null,
        watchPrice: null,
        priceAbove: null,
        priceBelow: null,
        risePercent: null,
        fallPercent: null,
        dailyProfitAmount: null,
        dailyLossAmount: null,
        totalProfitAmount: null,
        totalLossAmount: null
      }
    });
    return applyHoldingEdit(next, {
      securityCode: security.code,
      quantity: request.quantity,
      costPrice: request.costPrice,
      groupId: "all",
      note: "",
      expected: fields
    });
  }
  if (request.action !== "reorder" || !["holdings", "watchlist"].includes(String(request.kind)))
    throw new Error("排序操作无效");
  const rows =
    request.kind === "holdings" ? next.holdings : next.watchlist.sort((a, b) => a.order - b.order);
  const from = rows.findIndex((item) => item.securityCode === request.code);
  const to = rows.findIndex((item) => item.securityCode === request.targetCode);
  if (from < 0 || to < 0) throw new Error("股票列表已变化，请重新拖动");
  function move<T>(list: T[]): void {
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item!);
  }
  if (request.kind === "holdings") move(next.holdings);
  else move(next.watchlist);
  if (request.kind === "watchlist") {
    next.watchlist.forEach((row, index) => {
      row.order = index;
    });
    next.quotes.sort = "manual";
  }
  return next;
}

/** Restore only removed memberships, preserving edits made after deletion. */
export function restoreWatchlistItem(
  settings: UserSettings,
  original: WatchlistMembership,
  removedIds: string[]
): UserSettings {
  const next = structuredClone(settings);
  const ids = removedIds.filter((id) => next.watchlistGroups.some((group) => group.id === id));
  if (!ids.length) throw new Error("原分组已删除，无法撤销");
  const current = next.watchlist.find((row) => row.securityCode === original.securityCode);
  if (current) setMembershipGroups(current, [...membershipGroupIds(current), ...ids]);
  else {
    if (next.watchlist.length >= 50) throw new Error("自选股已达50只，无法撤销");
    const restored = { ...original };
    setMembershipGroups(restored, ids);
    next.watchlist.push(restored);
  }
  return next;
}
