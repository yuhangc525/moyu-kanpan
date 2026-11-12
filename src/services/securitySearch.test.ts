import assert from "node:assert/strict";
import { it } from "node:test";
import { parseSecuritySearch } from "./securitySearch.js";

it("keeps A-share markets and excludes indexes, foreign stocks and duplicates", () => {
  const result = parseSecuritySearch({
    QuotationCodeTable: {
      Data: [
        { Code: "600519", Name: "贵州茅台", QuoteID: "1.600519" },
        { Code: "000001", Name: "平安银行", QuoteID: "0.000001" },
        { Code: "920002", Name: "北交股票", QuoteID: "0.920002" },
        { Code: "000001", Name: "上证指数", QuoteID: "1.000001" },
        { Code: "600519", Name: "重复", QuoteID: "1.600519" },
        { Code: "00700", Name: "腾讯控股", QuoteID: "116.00700" },
        { Code: "510300", Name: "基金", QuoteID: "1.510300" }
      ]
    }
  });
  assert.deepEqual(
    result.map(({ code, market }) => ({ code, market })),
    [
      { code: "600519", market: "SH" },
      { code: "000001", market: "SZ" },
      { code: "920002", market: "BJ" }
    ]
  );
});

it("handles missing search data", () => {
  assert.deepEqual(parseSecuritySearch(null), []);
  assert.deepEqual(parseSecuritySearch({ QuotationCodeTable: { Data: {} } }), []);
});
