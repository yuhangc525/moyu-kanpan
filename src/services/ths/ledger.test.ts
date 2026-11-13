import assert from "node:assert/strict";
import { it } from "node:test";
import { loadAppConfigFromObject, toUserSettings } from "../../config.js";
import {
  ThsClient,
  parseThsPositions,
  mergeThsHoldings,
  normalizeThsCookie,
  type ThsPreview
} from "./ledger.js";
import { VTokenRefresher, refreshLedgerRequest } from "./v-token.js";
const row = { code: "000001", market: "1", name: "平安银行", count: "200", cost: "10.50" };
const data = { position: [row], currency: "CNY", total_liability: "0", upload_time: 1730000000000 };
function preview(): ThsPreview {
  return {
    ...parseThsPositions(data),
    portfolio: { id: "one", name: "账本一", broker: "" },
    queriedAt: new Date().toISOString(),
    token: "test"
  };
}
function settings() {
  return toUserSettings(
    loadAppConfigFromObject(
      {
        securities: [
          { code: "000001", name: "平安银行", market: "SZ" },
          { code: "600519", name: "贵州茅台", market: "SH" }
        ],
        holdings: [
          {
            securityCode: "000001",
            quantity: 100,
            costPrice: 9,
            note: "长期持有",
            alertRules: { enabled: true, stopLossPrice: 8 }
          },
          { securityCode: "600519", quantity: 100, costPrice: 1500 }
        ],
        watchlist: [{ securityCode: "600519", visible: true, order: 0, groupId: "all" }]
      },
      {}
    )
  );
}
it("parses supported positions and distinguishes explicit empty from missing or malformed data", () => {
  assert.deepEqual(parseThsPositions(data).positions, [
    { code: "000001", market: "SZ", name: "平安银行", quantity: 200, costPrice: 10.5 }
  ]);
  assert.ok(parseThsPositions(data).uploadedAt);
  assert.deepEqual(parseThsPositions({ position: [] }).positions, []);
  for (const input of [
    {},
    { ...data, position: null },
    { ...data, currency: "USD" },
    { ...data, total_liability: "100" },
    { ...data, position: [row, row] },
    ...[
      { cost: null },
      { count: "" },
      { cost: "-1" },
      { count: "1.5" },
      { market: "3" },
      { code: "900001", market: "2" }
    ].map((patch) => ({ ...data, position: [{ ...row, ...patch }] }))
  ])
    assert.throws(() => parseThsPositions(input));
});
it("merges quantity and cost while preserving existing reminder rules, groups, watchlists and notes", () => {
  const before = settings(),
    next = mergeThsHoldings(before, preview(), "merge");
  assert.equal(next.holdings.length, 2);
  const holding = next.holdings.find((item) => item.securityCode === "000001")!;
  assert.equal(holding.quantity, 200);
  assert.equal(holding.costPrice, 10.5);
  assert.equal(holding.note, "长期持有");
  assert.deepEqual(holding.alertRules, before.holdings[0]!.alertRules);
  assert.deepEqual(next.watchlist, before.watchlist);
  assert.deepEqual(next.watchlistGroups, before.watchlistGroups);
  assert.equal(before.holdings[0]!.quantity, 100);
  assert.equal(mergeThsHoldings(before, preview(), "replace").holdings.length, 1);
  assert.equal(
    mergeThsHoldings(before, { ...preview(), positions: [] }, "replace").holdings.length,
    0
  );
});
it("adds new holdings with disabled rules and rejects market conflicts without modifying input", () => {
  const before = settings();
  const p = preview();
  p.positions = [{ code: "510300", market: "SH", name: "沪深300ETF", quantity: 500, costPrice: 4 }];
  const next = mergeThsHoldings(before, p, "merge");
  assert.equal(next.holdings.at(-1)!.alertRules.enabled, false);
  assert.equal(next.securities.at(-1)!.name, "沪深300ETF");
  p.positions[0]!.code = "000001";
  assert.throws(() => mergeThsHoldings(before, p, "merge"), /市场/);
});
it("normalizes credentials without accepting unrelated user-id fields", () => {
  assert.equal(
    normalizeThsCookie("Cookie: userid=123; ticket=abc\nxyz"),
    "userid=123; ticket=abcxyz"
  );
  assert.throws(() => normalizeThsCookie("other_userid=123"));
});
it("lists multiple ledgers, selects exact ledger and posts read-only form payloads without redirects", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ThsClient((url, init) => {
    calls.push({ url, init });
    const ex_data = url.endsWith("account_list")
      ? {
          common: [
            { fund_key: "one", manualname: "账本一" },
            { fund_key: "two", manualname: "账本二" }
          ]
        }
      : url.endsWith("stock_position")
        ? data
        : { list: [] };
    return Promise.resolve(new Response(JSON.stringify({ error_code: 0, ex_data })));
  });
  assert.equal((await client.list("userid=123")).length, 2);
  const result = await client.positions("userid=123", "two");
  assert.equal(result.portfolio.id, "two");
  const request = calls.find((item) => item.url.endsWith("stock_position"))!;
  assert.equal(new URLSearchParams(String(request.init.body)).get("fund_key"), "two");
  assert.equal(request.init.redirect, "manual");
  assert.ok(request.init.signal);
  await assert.rejects(client.positions("userid=123", "missing"), /不存在/);
});
it("rejects expired credentials, redirects, business failures and missing position fields", async () => {
  for (const response of [
    new Response("", { status: 401 }),
    new Response("", { status: 302 }),
    new Response(JSON.stringify({ error_code: 1 })),
    new Response(JSON.stringify({ error_code: 0, ex_data: {} }))
  ]) {
    const client = new ThsClient(() => Promise.resolve(response));
    await assert.rejects(client.list("userid=123"));
  }
});
it("does not refresh token headers on unrelated origins or non-POST methods", () => {
  const init = { method: "POST", headers: { Cookie: "userid=123; v=invalid" } };
  assert.equal(refreshLedgerRequest("https://example.com/", init), init);
  assert.equal(new VTokenRefresher().refresh("userid=123; v=invalid"), "userid=123; v=invalid");
});
