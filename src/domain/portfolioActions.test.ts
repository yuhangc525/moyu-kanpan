import assert from "node:assert/strict";
import { it } from "node:test";
import { assertSavableSettings, loadAppConfigFromObject, toUserSettings } from "../config.js";
import { applyPortfolioAction, restoreWatchlistItem } from "./portfolioActions.js";
import { applyWatchlistAction, membershipGroupIds } from "./watchlistGroups.js";

function fixture() {
  return toUserSettings(
    loadAppConfigFromObject(
      {
        securities: [
          { code: "000001", market: "SZ", name: "平安银行" },
          { code: "600519", market: "SH", name: "贵州茅台" },
          { code: "601398", market: "SH", name: "工商银行" }
        ],
        watchlistGroups: [
          { id: "all", name: "默认分组" },
          { id: "bank", name: "银行" }
        ],
        watchlist: ["000001", "600519", "601398"],
        holdings: [
          {
            securityCode: "000001",
            quantity: 100,
            costPrice: 10,
            alertRules: { enabled: true, stopLossPrice: 8 }
          }
        ]
      },
      {}
    )
  );
}

it("adds a searched security to holdings without changing watchlist or existing reminders", () => {
  const original = fixture();
  const next = applyPortfolioAction(original, {
    action: "add",
    security: { code: "002407", market: "SZ", name: "多氟多" },
    quantity: 200,
    costPrice: 12.3456
  });
  assertSavableSettings(next);
  assert.equal(next.holdings[1].quantity, 200);
  assert.equal(next.holdings[1].alertRules.enabled, false);
  assert.deepEqual(next.holdings[0], original.holdings[0]);
  assert.deepEqual(next.watchlist, original.watchlist);
  assert.equal(original.holdings.length, 1);
});

it("rejects duplicates and invalid quantities, prices and securities without mutating settings", () => {
  const settings = fixture();
  const security = { code: "600519", market: "SH", name: "贵州茅台" };
  for (const patch of [
    { quantity: 0 },
    { quantity: 1.5 },
    { costPrice: 0 },
    { costPrice: NaN },
    { security: { ...security, code: "invalid" } },
    { security: { ...security, code: "000001" } }
  ])
    assert.throws(() =>
      applyPortfolioAction(settings, {
        action: "add",
        security,
        quantity: 100,
        costPrice: 100,
        ...patch
      })
    );
  assert.equal(settings.holdings.length, 1);
});

it("persists filtered-list moves and switches watchlist back to manual sorting", () => {
  const settings = fixture();
  settings.quotes.sort = "changePercentDesc";
  const next = applyPortfolioAction(settings, {
    action: "reorder",
    kind: "watchlist",
    code: "601398",
    targetCode: "000001"
  });
  assert.deepEqual(
    next.watchlist.map((row) => row.securityCode),
    ["601398", "000001", "600519"]
  );
  assert.deepEqual(
    next.watchlist.map((row) => row.order),
    [0, 1, 2]
  );
  assert.equal(next.quotes.sort, "manual");
  assert.deepEqual(next.holdings, settings.holdings);
  assert.throws(() =>
    applyPortfolioAction(next, {
      action: "reorder",
      kind: "holdings",
      code: "000001",
      targetCode: "600519"
    })
  );
});

it("reorders holdings without changing quantities, rules or watchlist memberships", () => {
  const settings = applyPortfolioAction(fixture(), {
    action: "add",
    security: { code: "600519", market: "SH", name: "贵州茅台" },
    quantity: 5,
    costPrice: 1400
  });
  const next = applyPortfolioAction(settings, {
    action: "reorder",
    kind: "holdings",
    code: "600519",
    targetCode: "000001"
  });
  assert.deepEqual(next.holdings, [...settings.holdings].reverse());
  assert.deepEqual(next.watchlist, settings.watchlist);
  assertSavableSettings(next);
});

it("undo merges removed memberships into latest settings and preserves holdings and later edits", () => {
  const original = applyWatchlistAction(fixture(), {
    action: "groups",
    code: "000001",
    groupIds: ["all", "bank"]
  });
  const item = original.watchlist[0];
  const deleted = applyWatchlistAction(original, {
    action: "remove-current",
    code: "000001",
    groupId: "bank"
  });
  deleted.holdings[0].quantity = 300;
  deleted.appearance.backgroundOpacity = 0.5;
  const next = restoreWatchlistItem(deleted, item, ["bank"]);
  assert.deepEqual(membershipGroupIds(next.watchlist[0]), ["all", "bank"]);
  assert.equal(next.holdings[0].quantity, 300);
  assert.equal(next.appearance.backgroundOpacity, 0.5);
  const allDeleted = applyWatchlistAction(original, { action: "remove-all", code: "000001" });
  const restored = restoreWatchlistItem(allDeleted, item, ["all", "bank"]);
  assert.deepEqual(
    membershipGroupIds(restored.watchlist.find((row) => row.securityCode === "000001")!),
    ["all", "bank"]
  );
  allDeleted.watchlistGroups = allDeleted.watchlistGroups.filter((group) => group.id !== "bank");
  assert.throws(() => restoreWatchlistItem(allDeleted, item, ["bank"]));
});
