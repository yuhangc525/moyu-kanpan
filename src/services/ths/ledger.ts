import {
  assertSavableSettings,
  MAX_HOLDING_QUANTITY,
  MAX_HOLDING_COST_PRICE,
  MIN_HOLDING_COST_PRICE,
  type UserSettings,
  type Security
} from "../../config.js";
import { fetchLedger, type FetchLike } from "./transport.js";
import type { ThsSyncStatus } from "./sync.js";

export interface ThsPortfolio {
  id: string;
  name: string;
  broker: string;
}
export interface ThsPosition {
  code: string;
  name: string;
  market: "SH" | "SZ";
  quantity: number;
  costPrice: number;
}
export interface ThsPreview {
  token: string;
  portfolio: ThsPortfolio;
  queriedAt: string;
  uploadedAt: string | null;
  positions: ThsPosition[];
}
export interface ThsStatus {
  configured: boolean;
  selectedId: string;
  portfolios: ThsPortfolio[];
  sync?: ThsSyncStatus;
}
export type ThsRequest =
  | { action: "status" | "login" | "cancel" | "logout" | "list" }
  | { action: "cookie"; cookie: string }
  | { action: "sync-configure"; enabled: boolean; portfolioId: string; intervalSeconds: number }
  | { action: "sync-now"; portfolioId: string; intervalSeconds: number }
  | { action: "preview"; portfolioId: string }
  | { action: "import"; token: string; mode: "merge" | "replace"; settings: UserSettings };
const BASE = "https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund/";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("同花顺响应格式异常");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function normalizeThsCookie(value: unknown): string {
  if (typeof value !== "string" || value.length > 32000) throw new Error("登录凭据无效");
  const cookie = value
    .replace(/^Cookie:\s*/i, "")
    .split(";")
    .map((part) => part.replace(/\s/g, ""))
    .filter(Boolean)
    .join("; ");
  if (!/(?:^|;\s*)userid=[^;]+/.test(cookie)) throw new Error("登录凭据缺少 userid，请重新登录");
  return cookie;
}
export class ThsClient {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}
  private async post(
    cookie: string,
    path: string,
    extra: Record<string, string>,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const user = /(?:^|;\s*)userid=([^;]+)/.exec(cookie)?.[1];
    if (!user) throw new Error("请先登录同花顺投资账本");
    let response: Response;
    try {
      response = await fetchLedger(
        this.fetchImpl,
        BASE + path,
        {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://tzzb.10jqka.com.cn/pc/index.html",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
          },
          body: new URLSearchParams({
            terminal: "1",
            version: "0.0.0",
            userid: user,
            user_id: user,
            ...extra
          }).toString()
        },
        { retryTransient: true }
      );
    } catch {
      throw new Error("同花顺查询超时或网络不可用，请稍后重试");
    }
    if (response.status === 401) throw new Error("同花顺登录已过期，请重新登录");
    if (!response.ok) throw new Error("同花顺暂时拒绝请求，请稍后重试或重新登录");
    let result: Record<string, unknown>;
    try {
      result = object(await response.json());
    } catch {
      throw new Error("同花顺响应格式异常，请稍后重试");
    }
    if (String(result.error_code) !== "0") throw new Error("同花顺拒绝查询，请检查账本或重新登录");
    return object(result.ex_data);
  }
  async list(cookie: string, signal = AbortSignal.timeout(20000)): Promise<ThsPortfolio[]> {
    const data = await this.post(cookie, "pc/account/v1/account_list", {}, signal);
    if (!Array.isArray(data.common)) throw new Error("账本列表格式异常");
    const seen = new Set<string>();
    return data.common.map((value: unknown) => {
      const row = object(value),
        id = text(row.fund_key);
      if (!id || id.length > 256 || seen.has(id)) throw new Error("账本标识缺失或重复");
      seen.add(id);
      return { id, name: text(row.manualname) || "未命名账本", broker: text(row.brokername) };
    });
  }
  async positions(cookie: string, id: string): Promise<Omit<ThsPreview, "token">> {
    const signal = AbortSignal.timeout(30000);
    const portfolio = (await this.list(cookie, signal)).find((item) => item.id === id);
    if (!portfolio) throw new Error("账本不存在，请刷新后重新选择");
    const data = await this.post(
      cookie,
      "pc/asset/v1/stock_position",
      { manual_id: "", fund_key: id, rzrq_fund_key: "", is_merge: "0" },
      signal
    );
    const parsed = parseThsPositions(data);
    // Names may be omitted by stock_position. Optional lookup never supplies quantity/cost.
    try {
      if (parsed.positions.length) {
        const names = await this.post(
          cookie,
          "pc/optional/v1/sort_list",
          { sort_rule: "", sort_order: "" },
          signal
        );
        if (Array.isArray(names.list))
          for (const value of names.list) {
            const row = object(value);
            const position = parsed.positions.find(
              (item) =>
                item.code === text(row.code) &&
                item.market === (text(row.market) === "1" ? "SZ" : "SH")
            );
            if (position && text(row.name)) position.name = text(row.name).slice(0, 24);
          }
      }
    } catch {
      /* Stock codes remain usable when the optional name service fails. */
    }
    return { ...parsed, portfolio, queriedAt: new Date().toISOString() };
  }
}
export function parseThsPositions(data: Record<string, unknown>): {
  positions: ThsPosition[];
  uploadedAt: string | null;
} {
  if (!Array.isArray(data.position)) throw new Error("持仓数据缺失，不能当作空仓导入");
  if (data.currency !== undefined && !["CNY", "RMB", "156"].includes(text(data.currency)))
    throw new Error("目前仅支持人民币普通账本");
  if (
    data.total_liability !== undefined &&
    data.total_liability !== null &&
    (text(data.total_liability).trim() === "" || Number(data.total_liability) !== 0)
  )
    throw new Error("暂不支持融资负债账本");
  if (data.position.length > 100) throw new Error("持仓超过100只，无法导入");
  const codes = new Set<string>();
  const positions = data.position.map((value: unknown) => {
    const row = object(value),
      code = text(row.code),
      market = text(row.market);
    if (!(market === "1" ? /^[013]\d{5}$/.test(code) : market === "2" && /^[56]\d{5}$/.test(code)))
      throw new Error("目前仅支持沪深人民币股票及ETF，不支持融资融券或其他市场");
    if (codes.has(code)) throw new Error("持仓代码重复，请检查账本");
    codes.add(code);
    const numeric = (value: unknown): number => {
      const raw = text(value).trim();
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw))
        throw new Error(`${code} 的数量或成本缺失、无效，未导入`);
      return Number(raw);
    };
    const quantity = numeric(row.count),
      costPrice = numeric(row.cost);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_HOLDING_QUANTITY ||
      !Number.isFinite(costPrice) ||
      costPrice < MIN_HOLDING_COST_PRICE ||
      costPrice > MAX_HOLDING_COST_PRICE
    )
      throw new Error(`${code} 的数量或成本超出本软件支持范围，未导入`);
    return {
      code,
      name: text(row.name).slice(0, 24) || code,
      market: (market === "1" ? "SZ" : "SH") as "SZ" | "SH",
      quantity,
      costPrice
    };
  });
  const stamp = text(data.upload_time);
  const uploadedAt =
    /^\d{13}$/.test(stamp) && Number.isFinite(new Date(Number(stamp)).getTime())
      ? new Date(Number(stamp)).toISOString()
      : null;
  return { positions, uploadedAt };
}
export function mergeThsHoldings(
  settings: UserSettings,
  preview: ThsPreview,
  mode: "merge" | "replace"
): UserSettings {
  assertSavableSettings(settings);
  const next = structuredClone(settings);
  const previous = new Map(settings.holdings.map((item) => [item.securityCode, item]));
  const incoming = preview.positions.map((position) => {
    const existing = previous.get(position.code);
    const security = next.securities.find((item) => item.code === position.code);
    if (!security)
      next.securities.push({
        code: position.code,
        name: position.name,
        alias: "",
        market: position.market
      } satisfies Security);
    else if (security.market !== position.market)
      throw new Error("本地证券市场与账本不一致，请先检查证券配置");
    else if (!security.name || security.name === security.code) security.name = position.name;
    return existing
      ? { ...existing, quantity: position.quantity, costPrice: position.costPrice }
      : {
          securityCode: position.code,
          quantity: position.quantity,
          costPrice: position.costPrice,
          groupId: "all",
          note: "",
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
        };
  });
  next.holdings =
    mode === "replace"
      ? incoming
      : [
          ...settings.holdings.filter(
            (item) => !incoming.some((row) => row.securityCode === item.securityCode)
          ),
          ...incoming
        ];
  assertSavableSettings(next);
  return next;
}
