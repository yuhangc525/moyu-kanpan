import type { Security } from "../config.js";
import { fetchWithTimeout } from "../providers/fetch.js";

export function parseSecuritySearch(value: unknown): Security[] {
  const rows = (value as { QuotationCodeTable?: { Data?: unknown } } | null)?.QuotationCodeTable
    ?.Data;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows
    .flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      const code = typeof row.Code === "string" ? row.Code : "";
      const name = typeof row.Name === "string" ? row.Name : "";
      const quoteId = typeof row.QuoteID === "string" ? row.QuoteID : "";
      if (!/^\d{6}$/.test(code) || !name || seen.has(code)) return [];
      const market =
        quoteId === `1.${code}` && /^(60|68)/.test(code)
          ? "SH"
          : quoteId === `0.${code}` && /^(00|30)/.test(code)
            ? "SZ"
            : /^(0|2)\./.test(quoteId) && /^(43|83|87|88|92)/.test(code)
              ? "BJ"
              : null;
      if (!market) return [];
      seen.add(code);
      return [{ code, name, market, alias: "" } satisfies Security];
    })
    .slice(0, 10);
}

export async function searchSecurities(query: unknown): Promise<Security[]> {
  if (typeof query !== "string" || !query.trim() || query.length > 40) return [];
  const url = new URL("https://searchapi.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", query.trim());
  url.searchParams.set("type", "14");
  url.searchParams.set("count", "10");
  const response = await fetchWithTimeout(fetch, url);
  if (!response.ok) throw new Error("股票搜索暂不可用，请重试");
  return parseSecuritySearch(await response.json());
}
