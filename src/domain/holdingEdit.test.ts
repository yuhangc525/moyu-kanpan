import assert from "node:assert/strict";
import { it } from "node:test";
import { loadAppConfigFromObject, toUserSettings, assertSavableSettings } from "../config.js";
import { applyHoldingEdit, type HoldingEditRequest } from "./holdingEdit.js";
import { createHoldingEditDraft, renderHoldingEditor } from "../presentation/holdingEditor.js";

function settings() {
  return toUserSettings(
    loadAppConfigFromObject(
      {
        watchlist: ["000001", "600519"],
        holdings: [
          {
            securityCode: "000001",
            quantity: 100,
            costPrice: 10,
            note: "原备注",
            alertRules: { enabled: true, stopLossPrice: 8 }
          }
        ],
        risk: { groups: [{ id: "bank", name: "银行组", enabled: true }] }
      },
      {}
    )
  );
}
function request(): HoldingEditRequest {
  return {
    securityCode: "000001",
    quantity: 200,
    costPrice: 9.5,
    groupId: "bank",
    note: "新备注",
    expected: { quantity: 100, costPrice: 10, groupId: "all", note: "原备注" }
  };
}

it("updates only the edited holding fields and preserves rules and unrelated settings", () => {
  const current = settings();
  current.watchlistGroups.push({ id: "tech", name: "科技" });
  const updated = applyHoldingEdit(current, request());
  assert.deepEqual(updated.holdings[0], {
    ...current.holdings[0],
    quantity: 200,
    costPrice: 9.5,
    groupId: "bank",
    note: "新备注"
  });
  assert.deepEqual(updated.holdings[0]?.alertRules, current.holdings[0]?.alertRules);
  assert.deepEqual(updated.watchlistGroups, current.watchlistGroups);
  assert.deepEqual(updated.watchlist, current.watchlist);
  assert.equal(current.holdings[0]?.quantity, 100);
  assertSavableSettings(updated);
});

it("rejects invalid quantities and costs without modifying the current holding", () => {
  const current = settings();
  for (const quantity of [0, -1, 1.5, Infinity, NaN, 1_000_000_001, "200"]) {
    assert.throws(() => applyHoldingEdit(current, { ...request(), quantity }), /数量/);
  }
  for (const costPrice of [0, -1, 0.00001, Infinity, NaN, 10_000_001, "10"]) {
    assert.throws(() => applyHoldingEdit(current, { ...request(), costPrice }), /成本价/);
  }
  assert.equal(current.holdings[0]?.quantity, 100);
});

it("rejects deleted holdings, missing risk groups, oversized notes and missing original values", () => {
  assert.throws(
    () => applyHoldingEdit(settings(), { ...request(), securityCode: "600519" }),
    /不存在/
  );
  assert.throws(() => applyHoldingEdit(settings(), { ...request(), groupId: "deleted" }), /风险组/);
  assert.throws(
    () => applyHoldingEdit(settings(), { ...request(), note: "字".repeat(121) }),
    /备注/
  );
  assert.throws(() => applyHoldingEdit(settings(), { ...request(), expected: null }), /原始持仓/);
  assert.throws(() => applyHoldingEdit(settings(), null), /无效/);
});

it("detects concurrent changes while allowing unrelated reminder changes", () => {
  for (const changed of [
    { quantity: 101 },
    { costPrice: 11 },
    { groupId: "bank" },
    { note: "其他编辑" }
  ]) {
    const current = settings();
    Object.assign(current.holdings[0]!, changed);
    assert.throws(() => applyHoldingEdit(current, request()), /其他页面修改/);
  }
  const current = settings();
  current.holdings[0]!.alertRules.stopLossPrice = 7;
  assert.equal(applyHoldingEdit(current, request()).holdings[0]?.alertRules.stopLossPrice, 7);
});

it("creates a detached draft so typing and cancelling cannot mutate saved values", () => {
  const current = settings();
  const draft = createHoldingEditDraft(current.holdings[0]!);
  draft.quantity = "";
  draft.costPrice = "9.";
  draft.note = "草稿";
  assert.equal(draft.expected.quantity, 100);
  assert.equal(current.holdings[0]?.note, "原备注");
  assert.equal(current.holdings[0]?.quantity, 100);
});

it("escapes editor text, shows current values and disables controls while saving", () => {
  const current = settings();
  const draft = createHoldingEditDraft(current.holdings[0]!);
  draft.note = '"><script>alert(1)</script>';
  const html = renderHoldingEditor(draft, current, true, "保存失败 <重试>");
  assert.match(html, /value="100"/);
  assert.match(html, /保存中…/);
  assert.match(html, /data-action="cancel-holding-edit" disabled/);
  assert.match(html, /银行组/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /保存失败 &lt;重试&gt;/);
  assert.doesNotMatch(html, /data-action="market-detail"/);
});
