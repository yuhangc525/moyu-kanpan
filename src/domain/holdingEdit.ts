import type { Holding, UserSettings } from "../config.js";
import { MAX_HOLDING_QUANTITY, MAX_HOLDING_COST_PRICE, MIN_HOLDING_COST_PRICE } from "../config.js";

export type HoldingEditableFields = Pick<Holding, "quantity" | "costPrice" | "groupId" | "note">;
export interface HoldingEditRequest extends HoldingEditableFields {
  securityCode: string;
  expected: HoldingEditableFields;
}

/** Apply a single holding patch to the latest settings; preserve reminder rules and unrelated edits. */
export function applyHoldingEdit(settings: UserSettings, value: unknown): UserSettings {
  if (!value || typeof value !== "object") throw new Error("持仓信息无效");
  const request = value as Record<string, unknown>;
  const holding = settings.holdings.find((item) => item.securityCode === request.securityCode);
  if (!holding) throw new Error("该持仓已不存在，请取消编辑后重试");
  const expected = request.expected;
  if (!expected || typeof expected !== "object") throw new Error("缺少原始持仓信息，请重新编辑");
  const base = expected as Record<string, unknown>;
  for (const key of ["quantity", "costPrice", "groupId", "note"] as const) {
    if (holding[key] !== base[key]) throw new Error("该持仓已在其他页面修改，请取消后重新编辑");
  }
  const { quantity, costPrice, groupId, note } = request;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_HOLDING_QUANTITY
  )
    throw new Error(`持仓数量须为 1–${MAX_HOLDING_QUANTITY} 的整数`);
  if (
    typeof costPrice !== "number" ||
    !Number.isFinite(costPrice) ||
    costPrice < MIN_HOLDING_COST_PRICE ||
    costPrice > MAX_HOLDING_COST_PRICE
  )
    throw new Error(`成本价须在 ${MIN_HOLDING_COST_PRICE}–${MAX_HOLDING_COST_PRICE} 之间`);
  if (
    typeof groupId !== "string" ||
    (groupId !== "all" && !settings.risk.groups.some((group) => group.id === groupId))
  )
    throw new Error("风险组不存在，请重新选择");
  if (typeof note !== "string" || note.length > 120) throw new Error("备注最多120字");
  const next = structuredClone(settings);
  const target = next.holdings.find((item) => item.securityCode === holding.securityCode)!;
  Object.assign(target, { quantity, costPrice, groupId, note });
  return next;
}
