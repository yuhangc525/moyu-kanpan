import type { Holding, UserSettings } from "../config.js";
import type { HoldingEditableFields } from "../domain/holdingEdit.js";
import { escapeAttr, escapeHtml } from "./format.js";

export interface HoldingEditDraft {
  securityCode: string;
  quantity: string;
  costPrice: string;
  groupId: string;
  note: string;
  expected: HoldingEditableFields;
}

export function createHoldingEditDraft(holding: Holding): HoldingEditDraft {
  const { quantity, costPrice, groupId, note } = holding;
  return {
    securityCode: holding.securityCode,
    quantity: String(quantity),
    costPrice: String(costPrice),
    groupId,
    note,
    expected: { quantity, costPrice, groupId, note }
  };
}

export function renderHoldingEditor(
  draft: HoldingEditDraft,
  settings: UserSettings,
  busy: boolean,
  message: string
): string {
  const security = settings.securities.find((item) => item.code === draft.securityCode);
  const name = security?.alias || security?.name || draft.securityCode;
  const disabled = busy ? "disabled" : "";
  return `<form class="holding-editor" aria-label="编辑持仓 ${escapeAttr(draft.securityCode)}">
    <strong>${escapeHtml(name)} · ${draft.securityCode}</strong>
    <div class="holding-edit-fields">
      <label>持仓数量（股）<input id="holding-edit-quantity" data-holding-field="quantity" inputmode="numeric" required value="${escapeAttr(draft.quantity)}" ${disabled}></label>
      <label>成本价（元）<input id="holding-edit-cost" data-holding-field="costPrice" inputmode="decimal" required value="${escapeAttr(draft.costPrice)}" ${disabled}></label>
      <label class="holding-edit-wide">风险组<select id="holding-edit-group" data-holding-field="groupId" ${disabled}>
        <option value="all" ${draft.groupId === "all" ? "selected" : ""}>未分组</option>
        ${draft.groupId !== "all" && !settings.risk.groups.some((group) => group.id === draft.groupId) ? `<option value="${escapeAttr(draft.groupId)}" selected disabled>原风险组已删除，请重新选择</option>` : ""}
        ${settings.risk.groups.map((group) => `<option value="${escapeAttr(group.id)}" ${draft.groupId === group.id ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("")}
      </select></label>
      <label class="holding-edit-wide">备注<input id="holding-edit-note" data-holding-field="note" maxlength="120" value="${escapeAttr(draft.note)}" ${disabled}></label>
    </div>
    <div class="holding-edit-actions"><button type="submit" ${disabled}>${busy ? "保存中…" : "保存"}</button><button type="button" data-action="cancel-holding-edit" ${disabled}>取消</button></div>
    <div role="status" class="holding-edit-message">${escapeHtml(message)}</div>
  </form>`;
}
