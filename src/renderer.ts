import {
  createHoldingEditDraft,
  renderHoldingEditor,
  type HoldingEditDraft
} from "./presentation/holdingEditor.js";
import {
  membershipGroupIds,
  type WatchlistAction,
  visibleWatchlistCodes,
  watchlistViewGroups,
  HOLDINGS_WATCHLIST_GROUP_ID
} from "./domain/watchlistGroups.js";
import { renderWatchlistGroups } from "./presentation/watchlistGroups.js";
import { importantDriverDecision } from "./domain/news.js";
import { benchmarkCodeForSecurity, buildDecisionCue } from "./domain/decision.js";
import type { QuoteField, Security, TabConfig, UserSettings } from "./config";
import type {
  AppSnapshot,
  DailyCandle,
  IntradayPoint,
  MarketDetail,
  MarketInstrumentRequest,
  MarketSeries,
  HoldingRiskMetrics,
  Quote
} from "./domain/types";
import {
  changeDirection,
  escapeAttr,
  escapeHtml,
  formatClockTime,
  formatClockTimeWithSeconds,
  formatFixedOrDash,
  formatSignedPercent
} from "./presentation/format.js";
import {
  chartBottomLabelY,
  chartPointX,
  chartValueY,
  nearestChartPointIndex,
  priceChange,
  type ChartPointLayout
} from "./presentation/chartInteraction.js";
import { describeAppSnapshotProblem } from "./domain/appSnapshotShape.js";

let holdingDraft: HoldingEditDraft | null = null;
let holdingEditBusy = false;
let holdingEditMessage = "";
let holdingComposing = false;

function updateHoldingDraft(input: HTMLInputElement | HTMLSelectElement): void {
  const field = input.dataset.holdingField;
  if (
    holdingDraft &&
    !holdingEditBusy &&
    (field === "quantity" || field === "costPrice" || field === "groupId" || field === "note")
  )
    holdingDraft[field] = input.value;
}

async function saveHoldingEdit(): Promise<void> {
  if (!holdingDraft || holdingEditBusy || !window.floatingStock) return;
  const draft = holdingDraft;
  holdingEditBusy = true;
  holdingEditMessage = "";
  render(snapshot);
  try {
    const settings = await window.floatingStock.updateHolding({
      securityCode: draft.securityCode,
      quantity: Number(draft.quantity),
      costPrice: Number(draft.costPrice),
      groupId: draft.groupId,
      note: draft.note,
      expected: draft.expected
    });
    snapshot = { ...snapshot, settings };
    holdingDraft = null;
    holdingEditMessage = "持仓已保存";
  } catch (error) {
    holdingEditMessage = error instanceof Error ? error.message : "保存失败，请重试";
  } finally {
    holdingEditBusy = false;
    render(snapshot);
  }
}

interface StockMenuState {
  code: string;
  groupId: string;
  x: number;
  y: number;
  editing: boolean;
  ids: string[];
  busy: boolean;
  message: string;
}
let stockMenu: StockMenuState | null = null;

function closeStockMenu(): void {
  if (stockMenu?.busy) return;
  stockMenu = null;
  document.getElementById("stock-context-menu")?.remove();
}

function renderStockMenu(): void {
  document.getElementById("stock-context-menu")?.remove();
  const menu = stockMenu;
  if (!menu) return;
  const element = document.createElement("section");
  element.id = "stock-context-menu";
  element.className = "stock-context-menu";
  element.setAttribute("aria-label", "自选股票操作");
  const security = snapshot.settings.securities.find((item) => item.code === menu.code);
  const item = snapshot.settings.watchlist.find((row) => row.securityCode === menu.code);
  const disabled = menu.busy ? "disabled" : "";
  const canRemoveCurrent =
    !!item &&
    snapshot.settings.watchlistGroups.some((group) => group.id === menu.groupId) &&
    membershipGroupIds(item).includes(menu.groupId);
  element.innerHTML = `<strong>${escapeHtml(security?.alias || security?.name || menu.code)} · ${menu.code}</strong>${
    menu.editing
      ? `
    <p>可同时选择多个分组</p>
    <div class="stock-group-options">${snapshot.settings.watchlistGroups.map((group) => `<label><input type="checkbox" data-stock-group="${escapeAttr(group.id)}" ${menu.ids.includes(group.id) ? "checked" : ""} ${disabled}>${escapeHtml(group.name)}</label>`).join("")}</div>
    <div class="stock-menu-actions"><button data-action="save-stock-groups" ${disabled}>${menu.busy ? "保存中…" : "保存"}</button><button data-action="close-stock-menu" ${disabled}>取消</button></div>`
      : `
    <button data-action="edit-stock-groups">调整分组</button>
    <button data-action="remove-stock-current" ${canRemoveCurrent ? "" : "disabled"} title="${canRemoveCurrent ? "只移除当前分组归属" : "请在普通分组中操作；持仓由持仓记录同步"}">从当前分组移除</button>
    <button data-action="remove-stock-all" ${item ? "" : "disabled"}>从全部自选删除</button>
    ${snapshot.settings.holdings.some((holding) => holding.securityCode === menu.code) ? "<p>持仓分组自动同步，以上操作不修改持仓。</p>" : ""}`
  }
    <div role="status">${escapeHtml(menu.message)}</div>`;
  rootElement.append(element);
  const rect = element.getBoundingClientRect();
  element.style.left = `${Math.max(6, Math.min(menu.x, window.innerWidth - rect.width - 6))}px`;
  element.style.top = `${Math.max(6, Math.min(menu.y, window.innerHeight - rect.height - 6))}px`;
}

async function manageStock(action: WatchlistAction["action"]): Promise<void> {
  const menu = stockMenu;
  if (!menu || menu.busy || !window.floatingStock) return;
  menu.busy = true;
  menu.message = "";
  renderStockMenu();
  try {
    const settings = await window.floatingStock.manageWatchlist({
      code: menu.code,
      action,
      groupId: menu.groupId,
      groupIds: menu.ids
    });
    stockMenu = null;
    snapshot = { ...snapshot, settings };
    stockMessage = action === "groups" ? "分组已更新" : "已移除自选归属；持仓记录不受影响";
    render(snapshot);
  } catch (error) {
    menu.busy = false;
    menu.message = error instanceof Error ? error.message : "操作失败，请重试";
    renderStockMenu();
  }
}

let selectedWatchlistGroup = "";
let stockQuery = "";
let stockResults: Security[] = [];
let stockMessage = "";
let stockBusy = false;
let stockSearchVersion = 0;

function renderStockSearch(): string {
  const targetGroup =
    selectedWatchlistGroup === HOLDINGS_WATCHLIST_GROUP_ID
      ? "all"
      : selectedWatchlistGroup || "all";
  const added = new Set(
    snapshot.settings.watchlist
      .filter((item) => item.visible && membershipGroupIds(item).includes(targetGroup))
      .map((item) => item.securityCode)
  );
  const addingToDefault = selectedWatchlistGroup === HOLDINGS_WATCHLIST_GROUP_ID;
  return `<section class="stock-search" aria-label="添加自选股票">
    ${
      stockMessage || stockResults.length || stockBusy
        ? `<div class="stock-search-panel">
      <div class="stock-search-heading"><span>${stockResults.length || stockBusy ? "搜索结果" : "操作提示"}</span><button type="button" data-action="close-stock-search" aria-label="关闭提示" title="关闭提示" ${stockBusy ? "disabled" : ""}>×</button></div>
      <div role="status" class="stock-search-message">${escapeHtml(stockMessage)}</div>
      <div class="stock-search-results">${stockResults
        .map(
          (item, index) => `<div class="stock-search-result">
        <span><strong>${escapeHtml(item.name)}</strong><small>${item.market}.${item.code}</small></span>
        <button data-action="add-watch-stock" data-index="${index}" ${stockBusy || added.has(item.code) ? "disabled" : ""}>${added.has(item.code) ? "已添加" : addingToDefault ? "加入默认分组" : "加入自选"}</button>
      </div>`
        )
        .join("")}</div>
    </div>`
        : ""
    }
    <form class="stock-search-form" aria-busy="${stockBusy}">
      <input id="stock-query" aria-label="股票代码或简称" placeholder="${addingToDefault ? "代码或简称，添加至默认分组" : "输入股票代码或简称"}" maxlength="40" value="${escapeAttr(stockQuery)}" autocomplete="off">
      <button class="stock-search-add" type="submit" aria-label="搜索并添加股票" title="搜索并添加股票" ${stockBusy ? "disabled" : ""}>${stockBusy ? "…" : "+"}</button>
    </form>
  </section>`;
}

async function searchStocks(): Promise<void> {
  if (!window.floatingStock || stockBusy) return;
  const query = stockQuery.trim();
  if (!query) {
    stockMessage = "请输入股票代码或简称";
    render(snapshot);
    return;
  }
  const version = ++stockSearchVersion;
  stockBusy = true;
  stockResults = [];
  stockMessage = "正在搜索…";
  render(snapshot);
  try {
    const results = await window.floatingStock.searchSecurities(query);
    if (version !== stockSearchVersion) return;
    stockResults = results;
    stockMessage = results.length ? "" : "未找到股票，请尝试完整代码或简称";
  } catch {
    if (version === stockSearchVersion) stockMessage = "搜索失败，请检查网络后重试";
  } finally {
    if (version === stockSearchVersion) {
      stockBusy = false;
      render(snapshot);
    }
  }
}

async function addWatchStock(index: number): Promise<void> {
  const security = stockResults[index];
  if (!security || stockBusy || !window.floatingStock) return;
  const targetGroup =
    selectedWatchlistGroup === HOLDINGS_WATCHLIST_GROUP_ID
      ? "all"
      : selectedWatchlistGroup || "all";
  stockBusy = true;
  render(snapshot);
  try {
    const settings = await window.floatingStock.addWatchStock(security, targetGroup);
    if (selectedWatchlistGroup === HOLDINGS_WATCHLIST_GROUP_ID)
      selectedWatchlistGroup = targetGroup;
    snapshot = { ...snapshot, settings };
    stockMessage = `${security.name} 已加入自选`;
  } catch (error) {
    stockMessage = error instanceof Error ? error.message : "添加失败，请重试";
  } finally {
    stockBusy = false;
    render(snapshot);
  }
}

const defaultSettings: UserSettings = {
  schemaVersion: 11,
  personalSeedVersion: 0,
  securities: [
    { code: "000001", market: "SZ", name: "", alias: "" },
    { code: "600519", market: "SH", name: "", alias: "" }
  ],
  holdings: [],
  watchlistGroups: [{ id: "all", name: "默认分组" }],
  watchlist: [
    { securityCode: "000001", visible: true, order: 0, groupId: "all" },
    { securityCode: "600519", visible: true, order: 1, groupId: "all" }
  ],
  tabs: [
    {
      id: "holdings",
      type: "holdings",
      title: "持仓",
      builtIn: true,
      visible: true,
      order: 0,
      securityCodes: [],
      maxItems: 8,
      newsMode: "watchlist_related"
    },
    {
      id: "watchlist",
      type: "watchlist",
      title: "自选",
      builtIn: true,
      visible: true,
      order: 1,
      securityCodes: [],
      maxItems: 20,
      newsMode: "watchlist_related"
    },
    {
      id: "market",
      type: "market",
      title: "市场",
      builtIn: true,
      visible: true,
      order: 2,
      securityCodes: [],
      maxItems: 8,
      newsMode: "all"
    },
    {
      id: "drivers",
      type: "drivers",
      title: "AI驱动",
      builtIn: true,
      visible: true,
      order: 3,
      securityCodes: [],
      maxItems: 5,
      newsMode: "important"
    }
  ],
  navigation: {
    defaultTabId: "watchlist",
    rememberLastTab: false,
    lastActiveTabId: "watchlist"
  },
  quotes: {
    fields: ["price", "changePercent", "change"],
    sort: "manual"
  },
  news: {
    mode: "all",
    maxItems: 5
  },
  appearance: {
    theme: "standard",
    backgroundOpacity: 0.82
  },
  ai: {
    enabled: true,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    allowInsecureHttp: false,
    model: "deepseek-v4-flash",
    timeoutSeconds: 20
  },
  risk: {
    mode: "shadow",
    accountBaseline: null,
    oneR: null,
    maxPositionValue: null,
    maxHoldingCount: null,
    maxTotalExposurePercent: null,
    portfolioDailyProfitThreshold: null,
    portfolioDailyLossThreshold: null,
    stopWarningPercent: 2,
    hysteresisPercent: 0.2,
    cooldownMinutes: 15,
    oncePerDay: false,
    onlyDuringTrading: true,
    notifications: { widget: true, tray: true, windows: false },
    groups: []
  },
  window: {
    width: 380,
    height: 520,
    x: null,
    y: null,
    alwaysOnTop: true,
    trayOnly: true,
    bossKeyEnabled: true,
    bossKeyAccelerator: "CommandOrControl+Alt+Space",
    clickThrough: false,
    locked: false
  }
};

const emptySnapshot: AppSnapshot = {
  quotes: [],
  news: [],
  risk: {
    mode: "shadow",
    paused: false,
    pausedThroughDate: null,
    dataSafe: false,
    holdings: [],
    groups: [],
    portfolio: {
      holdingCount: 0,
      marketValue: null,
      dailyPnl: null,
      totalPnl: null,
      dailyPnlR: null,
      totalPnlR: null,
      exposurePercent: null,
      dataSafe: false,
      violations: []
    },
    recentEvents: [],
    updatedAt: new Date(0).toISOString()
  },
  ai: {
    enabled: false,
    configured: false,
    secureStorageAvailable: false,
    credentialSource: "none",
    state: "unconfigured",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    lastTestedAt: null,
    lastSuccessAt: null,
    message: "未配置 API Key，使用本地规则"
  },
  market: {
    indices: [],
    breadth: { upCount: null, downCount: null, flatCount: null, amount: null },
    sectors: [],
    intraday: { items: [], source: null, stale: true, updatedAt: null, error: null },
    source: null,
    stale: true,
    degraded: false,
    updatedAt: null,
    errors: []
  },
  errors: [],
  updatedAt: new Date().toISOString(),
  settings: defaultSettings,
  feeds: {
    quotes: {
      lastSuccessAt: null,
      dataUpdatedAt: null,
      lastChangedAt: null,
      stale: true,
      stalled: false,
      source: null,
      coverage: null,
      degraded: false,
      conflictCount: 0,
      retainedCount: 0,
      missingCount: 0,
      alertSafe: false,
      providerHealth: [],
      marketState: null
    },
    news: {
      lastSuccessAt: null,
      dataUpdatedAt: null,
      lastChangedAt: null,
      stale: true,
      stalled: false,
      source: null,
      coverage: null,
      degraded: false,
      conflictCount: 0,
      retainedCount: 0,
      missingCount: 0,
      alertSafe: false,
      providerHealth: [],
      marketState: null
    }
  },
  ui: {
    clickThrough: false
  }
};

const fieldLabels: Record<QuoteField, string> = {
  price: "现价",
  change: "涨跌额",
  changePercent: "涨幅",
  open: "开盘",
  previousClose: "昨收",
  high: "最高",
  low: "最低",
  volume: "成交量",
  amount: "成交额",
  mainInflow: "主力流入"
};

let snapshot = emptySnapshot;
let clickThrough = false;
let activeTabId = defaultSettings.navigation.defaultTabId;
let navigationInitialized = false;
let marketDetailRequest: MarketInstrumentRequest | null = null;
let marketDetail: MarketDetail | null = null;
let marketDetailLoading = false;
let marketDetailError: string | null = null;
let marketChartMode: "intraday" | "daily" | "boll" = "intraday";
// 行情快照会重建详情 DOM；保留指针位置，才能在鼠标静止时恢复悬浮数据。
let chartPointerPosition: ChartPointerPosition | null = null;
let marketDetailRequestId = 0;
let marketDetailRefreshTimer: number | null = null;
let lastRenderedPageKey = "";
let copyFeedbackTimer: number | null = null;
/** 边界自检发现的第一处形状问题（§4-4）：非空时在部件顶部显示，避免状态栏"说谎"。 */
let shapeProblem: string | null = null;

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
const rootElement = root;

function render(next: AppSnapshot): void {
  // Keep an active IME composition intact while quote snapshots arrive.
  if (
    holdingComposing ||
    (document.activeElement instanceof HTMLSelectElement &&
      document.activeElement.dataset.holdingField)
  ) {
    snapshot = next;
    return;
  }
  const focusedInput =
    document.activeElement instanceof HTMLInputElement &&
    (document.activeElement.id === "stock-query" || document.activeElement.dataset.holdingField)
      ? document.activeElement
      : null;
  const inputSelection = focusedInput
    ? { id: focusedInput.id, start: focusedInput.selectionStart, end: focusedInput.selectionEnd }
    : null;
  // 真正的滚动容器是 .scroll-list（styles.css 里 .page-body 是 overflow: hidden，从不滚动），
  // 而它在下面被 innerHTML 整体替换。合并页同时有行情与新闻两个列表，因此按顺序逐个保存/恢复。
  const previousScrollTops = [...rootElement.querySelectorAll<HTMLElement>(".scroll-list")].map(
    (element) => element.scrollTop
  );
  if (copyFeedbackTimer != null) {
    window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
  snapshot = next;
  clickThrough = next.ui.clickThrough;
  applyAppearance(next.settings);
  const tab = resolveActiveTab(next.settings);
  const pageTitle = marketDetailRequest ? marketDetail?.instrument.name || "走势详情" : tab.title;
  const pageKey = marketDetailRequest
    ? `detail:${marketDetailRequest.kind}:${marketDetailRequest.market}:${marketDetailRequest.code}`
    : tab.id;

  // 外壳（标题栏 / 标签栏 / 页脚）只建一次，之后只改变化的部分：
  // 整页 innerHTML 替换会打断用户正在展开的标签溢出下拉、丢掉焦点与 :hover（§4-2）。
  const frame = ensureShell(tab);
  if (frame.title.textContent !== pageTitle) frame.title.textContent = pageTitle;
  if (frame.clickThroughButton.getAttribute("aria-pressed") !== String(clickThrough)) {
    frame.clickThroughButton.classList.toggle("active", clickThrough);
    frame.clickThroughButton.setAttribute("aria-pressed", String(clickThrough));
    frame.clickThroughButton.title = clickThrough
      ? "点击穿透已开启，可用快捷键关闭"
      : "开启鼠标点击穿透";
  }

  const signature = tabBarSignature(next.settings, tab.id);
  if (signature !== frame.tabBarSignature) {
    frame.tabBar.innerHTML = renderTabBarContent(next.settings, tab.id);
    frame.tabBarSignature = signature;
  }

  // 数据区每次推送都重建（价格/新闻本来就在变），但外壳与其中的滚动容器保持稳定。
  frame.pageContent.innerHTML = `
        ${renderShapeProblem()}
        ${renderRecentAlert(snapshot)}
        ${renderErrors(snapshot.errors)}
        <div class="page-body">
          ${renderPage(tab, next)}
        </div>
  `;
  frame.footer.innerHTML = `
        ${renderFeedStatus("行情", snapshot.feeds.quotes)}
        ${renderFeedStatus("资讯", snapshot.feeds.news)}
  `;

  if (pageKey === lastRenderedPageKey) {
    rootElement.querySelectorAll<HTMLElement>(".scroll-list").forEach((element, index) => {
      const previous = previousScrollTops[index];
      if (previous != null) element.scrollTop = previous;
    });
  }
  if (inputSelection) {
    const input = document.getElementById(inputSelection.id) as HTMLInputElement | null;
    input?.focus();
    input?.setSelectionRange(inputSelection.start, inputSelection.end);
  }
  renderStockMenu();
  restoreChartHover();
  lastRenderedPageKey = pageKey;
}

interface WidgetShell {
  main: HTMLElement;
  title: HTMLElement;
  clickThroughButton: HTMLButtonElement;
  tabBar: HTMLElement;
  tabBarSignature: string;
  pageContent: HTMLElement;
  footer: HTMLElement;
}

let shell: WidgetShell | null = null;

/**
 * 建立或复用部件外壳。
 *
 * 页面类型变化（`page-*` 类决定布局与配色）或外壳被替换过时才重建，
 * 其余情况一律复用同一批 DOM 节点。
 */
function ensureShell(tab: TabConfig): WidgetShell {
  const mainClass = `widget page-${tab.type}`;
  if (shell && shell.main.isConnected && shell.main.className === mainClass) return shell;

  rootElement.innerHTML = `
    <main class="${mainClass}">
      <header class="drag header">
        <div>
          <div class="eyebrow">摸鱼看盘</div>
          <h1></h1>
        </div>
        <div class="controls no-drag" aria-label="窗口工具">
          <button data-action="hide" title="隐藏到托盘" aria-label="隐藏到托盘">隐</button>
          <button data-action="theme" title="切换标准/低调模式" aria-label="切换色彩模式">彩</button>
          <button data-action="click-through" title="开启鼠标点击穿透" aria-label="点击穿透" aria-pressed="false">穿</button>
          <button data-action="settings" title="页面、自选与外观设置" aria-label="打开设置">设</button>
        </div>
      </header>
      <nav class="tabs no-drag" aria-label="看盘页面"></nav>
      <section class="page-content"></section>
      <footer class="drag footer"></footer>
    </main>
  `;

  const main = rootElement.querySelector<HTMLElement>("main.widget");
  const title = main?.querySelector<HTMLElement>("h1");
  const clickThroughButton = main?.querySelector<HTMLButtonElement>(
    'button[data-action="click-through"]'
  );
  const tabBar = main?.querySelector<HTMLElement>("nav.tabs");
  const pageContent = main?.querySelector<HTMLElement>("section.page-content");
  const footer = main?.querySelector<HTMLElement>("footer.footer");
  if (!main || !title || !clickThroughButton || !tabBar || !pageContent || !footer) {
    throw new Error("部件外壳渲染失败");
  }

  shell = {
    main,
    title,
    clickThroughButton,
    tabBar,
    tabBarSignature: "",
    pageContent,
    footer
  };
  return shell;
}

function resolveActiveTab(settings: UserSettings): TabConfig {
  const visibleTabs = settings.tabs.filter((tab) => tab.visible).sort((a, b) => a.order - b.order);
  const preferred = settings.navigation.rememberLastTab
    ? settings.navigation.lastActiveTabId
    : settings.navigation.defaultTabId;

  if (!navigationInitialized || !visibleTabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = visibleTabs.some((tab) => tab.id === preferred)
      ? preferred
      : (visibleTabs[0]?.id ?? "watchlist");
    navigationInitialized = true;
  }

  return (
    visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0] ?? defaultSettings.tabs[1]!
  );
}

/** 标签栏内容（外壳的 `<nav>` 由 `ensureShell` 持有，这里只给内部标记）。 */
function renderTabBarContent(settings: UserSettings, currentId: string): string {
  const tabs = settings.tabs.filter((tab) => tab.visible).sort((a, b) => a.order - b.order);
  const primary = tabs.slice(0, 4);
  const overflow = tabs.slice(4);
  const overflowActive = overflow.find((tab) => tab.id === currentId);
  return `
      ${primary
        .map(
          (tab) => `
        <button class="tab ${tab.id === currentId ? "active" : ""}" data-action="tab" data-tab-id="${escapeAttr(tab.id)}">
          ${escapeHtml(tab.title)}
        </button>
      `
        )
        .join("")}
      ${
        overflow.length
          ? `
        <select class="tab-overflow ${overflowActive ? "active" : ""}" data-action="tab-overflow" aria-label="更多页面">
          <option value="">${overflowActive ? escapeHtml(overflowActive.title) : "更多"} ···</option>
          ${overflow.map((tab) => `<option value="${escapeAttr(tab.id)}">${escapeHtml(tab.title)}</option>`).join("")}
        </select>
      `
          : ""
      }
  `;
}

/**
 * 标签栏结构签名：只有它变化时才重建标签栏。
 *
 * 行情每 3 秒推一次，但标签集合基本不变；重建会把用户正在展开的溢出 `<select>`
 * 和 `:hover` 状态一起打断（审计报告 §4-2）。
 */
function tabBarSignature(settings: UserSettings, currentId: string): string {
  const tabs = settings.tabs
    .filter((tab) => tab.visible)
    .sort((a, b) => a.order - b.order)
    .map((tab) => `${tab.id}:${tab.title}`);
  return `${tabs.join("|")}|active:${currentId}`;
}

function renderPage(tab: TabConfig, next: AppSnapshot): string {
  if (marketDetailRequest) return renderMarketDetail();
  if (tab.type === "holdings") return renderHoldings(next);
  if (tab.type === "watchlist") {
    if (!watchlistViewGroups(next.settings).some((group) => group.id === selectedWatchlistGroup))
      selectedWatchlistGroup = "";
    const codes = visibleWatchlistCodes(next.settings, selectedWatchlistGroup);
    const emptyText =
      selectedWatchlistGroup === HOLDINGS_WATCHLIST_GROUP_ID
        ? "暂无持仓，添加持仓后会自动同步到这里。"
        : "当前分组暂无股票，可在下方搜索添加。";
    return `<div class="watchlist-page">${renderWatchlistGroups(next.settings, selectedWatchlistGroup)}${codes.length ? renderQuoteList(codes, next) : `<div class="empty-state">${emptyText}</div>`}${renderStockSearch()}</div>`;
  }
  if (tab.type === "stock-list") return renderQuoteList(tab.securityCodes, next);
  if (tab.type === "drivers") return renderNews(next, tab.maxItems, tab.newsMode);
  if (tab.type === "combined") return renderCombined(next, tab);
  return renderMarketOverview(next.market);
}

function renderHoldings(next: AppSnapshot): string {
  if (
    holdingDraft &&
    !next.settings.holdings.some((item) => item.securityCode === holdingDraft?.securityCode)
  ) {
    holdingDraft = null;
    holdingEditMessage = "该持仓已被移除";
  }
  const quoteMap = new Map(next.quotes.map((quote) => [quote.code, quote]));
  const riskMap = new Map(next.risk.holdings.map((item) => [item.securityCode, item]));
  const rows = next.settings.holdings
    .map((holding) =>
      renderHoldingRow(
        holding,
        quoteMap.get(holding.securityCode),
        riskMap.get(holding.securityCode),
        next.settings
      )
    )
    .join("");

  if (!rows) {
    return `<div class="empty-state"><strong>尚未配置持仓</strong><span>可在设置中填写数量和成本价。</span></div>`;
  }

  // 汇总卡直接使用风险模型（PortfolioRiskMetrics）：任一持仓缺报价时它整体返回 null，
  // 由格式化函数显示 "--"。此前的局部累加会静默跳过无报价持仓，给出偏小的"确定"数字，
  // 与下方风险面板的"数据不安全"提示自相矛盾。
  const portfolio = next.risk.portfolio;
  // 成本额不依赖行情，可以对全部持仓求和，用于计算累计盈亏百分比。
  const costValue = next.settings.holdings.reduce(
    (sum, holding) => sum + holding.costPrice * holding.quantity,
    0
  );
  const totalPercent =
    portfolio.totalPnl != null && costValue > 0 ? (portfolio.totalPnl / costValue) * 100 : null;

  return `
    <div class="holdings-page">
      <div class="portfolio-summary">
        <span><small>持仓市值</small><strong>${formatMoney(portfolio.marketValue)}</strong></span>
        <span class="${numberDirection(portfolio.dailyPnl)}"><small>今日盈亏*${formatRLabel(portfolio.dailyPnlR)}</small><strong>${formatSignedMoney(portfolio.dailyPnl)}</strong></span>
        <span class="${numberDirection(portfolio.totalPnl)}"><small>累计盈亏${formatRLabel(portfolio.totalPnlR)}</small><strong>${formatSignedMoney(portfolio.totalPnl)} / ${formatPercent(totalPercent)}</strong></span>
        ${next.settings.holdings.length ? '<p class="pnl-note">* 当日有买卖时，今日盈亏仅供参考</p>' : ""}
      </div>
      ${renderRiskStatus(next)}
      <div class="scroll-list holding-list">${!holdingDraft && holdingEditMessage ? `<div role="status" class="holding-edit-message">${escapeHtml(holdingEditMessage)}</div>` : ""}${rows}</div>
    </div>
  `;
}

function renderHoldingRow(
  holding: UserSettings["holdings"][number],
  quote: Quote | undefined,
  risk: HoldingRiskMetrics | undefined,
  settings: UserSettings
): string {
  if (holdingDraft?.securityCode === holding.securityCode)
    return renderHoldingEditor(holdingDraft, settings, holdingEditBusy, holdingEditMessage);
  const security = securityFor(settings, holding.securityCode);
  const price = quote?.price;
  // 累计盈亏直接用风险模型的指标：它用 finitePositive 清洗过价格，且数据不安全时整体为
  // null（显示 "--"），与风险面板/汇总卡口径一致。此前这里拿原始 quote.price 自行相除，
  // 今天能和风险面板对上只是因为上游不变量，属于潜在漂移。
  const profit = risk?.totalPnl ?? null;
  const profitPercent = risk?.totalPnlPercent ?? null;
  const dailyDirection = quoteDirection(quote);

  return `
    <article class="quote-row holding-row ${dailyDirection}" ${marketDetailAttributes("stock", security?.market ?? quote?.market, holding.securityCode)}>
      <div class="quote-name">
        <strong>${escapeHtml(security?.alias || security?.name || quote?.name || holding.securityCode)}</strong>
        <span>${security?.market ?? quote?.market ?? ""}.${holding.securityCode} · ${formatQuantity(holding.quantity)}股 @ ${formatNumber(holding.costPrice)}${renderQuoteQuality(quote)}${renderHoldingRiskHint(risk)}</span>
        <button type="button" class="holding-edit-button" data-action="edit-holding" data-code="${escapeAttr(holding.securityCode)}" ${holdingDraft || holdingEditBusy ? "disabled" : ""}>编辑</button>
      </div>
      <div class="holding-metrics">
        <span><small>现价</small><strong>${formatNumber(price)}</strong></span>
        <span class="${numberDirection(risk?.dailyPnl)}"><small>今日</small><strong>${formatSignedMoney(risk?.dailyPnl)}</strong></span>
        <span class="${numberDirection(profit)}"><small>累计${formatRLabel(risk?.totalPnlR)}</small><strong>${formatSignedMoney(profit)} / ${formatPercent(profitPercent)}</strong></span>
      </div>
    </article>
  `;
}

function renderQuoteList(codes: string[], next: AppSnapshot): string {
  const orderedCodes = sortCodes(codes, next.quotes, next.settings);
  const quoteMap = new Map(next.quotes.map((quote) => [quote.code, quote]));
  if (orderedCodes.length === 0) {
    return `<div class="empty-state"><strong>这个页面还没有股票</strong><span>在设置中添加或选择股票。</span></div>`;
  }

  return `<div class="scroll-list quote-list">${orderedCodes
    .map((code) => renderQuote(code, quoteMap.get(code), next.settings))
    .join("")}</div>`;
}

function renderRiskStatus(next: AppSnapshot): string {
  const risk = next.risk;
  const violations = risk.portfolio.violations.slice(0, 2);
  const groups = risk.groups.filter((group) => group.memberCount > 0).slice(0, 3);
  return `
    <div class="risk-status ${risk.dataSafe ? "" : "unsafe"}">
      <div class="risk-status-head">
        <span><strong>${risk.mode === "shadow" ? "影子计算" : "正式提醒"}</strong> · ${risk.paused ? "已暂停" : risk.dataSafe ? "数据可用" : "数据不安全"}</span>
        <button data-action="${risk.paused ? "alerts-resume" : "alerts-pause"}">${risk.paused ? "恢复" : "暂停"}</button>
      </div>
      ${violations.length ? `<div class="risk-violations">${violations.map((item) => `<span class="${item.severity}">${escapeHtml(item.title)}</span>`).join("")}</div>` : ""}
      ${groups.length ? `<div class="risk-groups">${groups.map((group) => `<span>${escapeHtml(group.name)} ${formatSignedMoney(group.totalPnl)}</span>`).join("")}</div>` : ""}
    </div>
  `;
}

function renderHoldingRiskHint(risk: HoldingRiskMetrics | undefined): string {
  if (!risk) return "";
  if (!risk.dataSafe) return ' <em class="risk-badge unsafe">停用</em>';
  const breach = risk.violations.find((item) => item.severity === "breach");
  if (breach)
    return ` <em class="risk-badge breach" title="${escapeAttr(breach.message)}">越线</em>`;
  const warning = risk.violations[0];
  if (warning)
    return ` <em class="risk-badge warning" title="${escapeAttr(warning.message)}">预警</em>`;
  return "";
}
function renderCombined(next: AppSnapshot, tab: TabConfig): string {
  const codes = next.settings.holdings.length
    ? next.settings.holdings.map((holding) => holding.securityCode).slice(0, 4)
    : watchlistCodes(next.settings).slice(0, 4);
  return `
    <div class="combined">
      <div class="combined-quotes">${renderQuoteList(codes, next)}</div>
      <div class="combined-news">${renderNews(next, Math.min(2, tab.maxItems), "important")}</div>
    </div>
  `;
}

function renderMarketOverview(market: AppSnapshot["market"]): string {
  if (market.indices.length === 0) {
    const message =
      market.errors.length > 0
        ? "市场数据暂不可用，实时行情不受影响。"
        : "正在加载指数和市场宽度。";
    return `<div class="empty-state"><strong>市场概览加载中</strong><span>${message}</span></div>`;
  }

  const breadth = market.breadth;
  const state = market.stale ? "缓存" : market.degraded ? "降级" : "实时";
  const diagnostics = market.errors.join("；");
  return `
    <div class="market-overview">
      <div class="market-breadth" title="${escapeAttr(diagnostics)}">
        <span class="up"><small>上涨</small><strong>${formatInteger(breadth.upCount)}</strong></span>
        <span class="down"><small>下跌</small><strong>${formatInteger(breadth.downCount)}</strong></span>
        <span><small>平盘</small><strong>${formatInteger(breadth.flatCount)}</strong></span>
        <span><small>两市额</small><strong>${formatMarketAmount(breadth.amount)}</strong></span>
      </div>
      <div class="market-index-grid">
        ${market.indices
          .map(
            (item) => `
          <button class="market-index ${numberDirection(item.changePercent)}" data-action="market-detail" data-kind="index" data-market="${item.instrument.market}" data-code="${item.instrument.code}">
            <span>${escapeHtml(shortIndexName(item.instrument.name))}</span>
            <strong>${formatNumber(item.price)}</strong>
            <em>${formatPercent(item.changePercent)}</em>
          </button>
        `
          )
          .join("")}
      </div>
      <section class="market-preview">
        <div class="section-caption"><span>上证分时</span><em>${dataSourceLabel(market.intraday.source)}${market.intraday.stale ? " · 缓存" : ""}</em></div>
        ${renderIntradayChart(market.intraday, true)}
      </section>
      <section class="market-sectors">
        <div class="section-caption"><span>领涨行业</span><em>${state} · ${dataSourceLabel(market.source)}</em></div>
        <div class="sector-list">
          ${
            market.sectors
              .slice(0, 5)
              .map(
                (item) => `
            <span class="sector-chip ${numberDirection(item.changePercent)}"><b>${escapeHtml(item.name)}</b><em>${formatPercent(item.changePercent)}</em></span>
          `
              )
              .join("") || '<span class="sector-empty">行业数据暂不可用</span>'
          }
        </div>
      </section>
    </div>
  `;
}

function renderMarketDetail(): string {
  if (marketDetailLoading && !marketDetail) {
    return `<div class="empty-state"><strong>正在加载走势</strong><span>分时和日K独立请求，不影响实时行情。</span></div>`;
  }
  if (!marketDetail) {
    return `
      <div class="empty-state">
        <strong>走势暂不可用</strong>
        <span>${escapeHtml(marketDetailError ?? "未知错误")}</span>
        <button class="inline-action" data-action="market-back">返回</button>
      </div>
    `;
  }

  const series = marketChartMode === "intraday" ? marketDetail.intraday : marketDetail.daily;
  const sourceState = `${dataSourceLabel(series.source)}${series.stale ? " · 缓存" : ""}`;
  return `
    <div class="market-detail">
      <div class="market-detail-toolbar">
        <button data-action="market-back">← 返回</button>
        <span>${marketDetail.instrument.market}.${marketDetail.instrument.code}</span>
        <em title="${escapeAttr(series.error ?? "")}">${sourceState}</em>
      </div>
      <div class="chart-tabs">
        ${chartModeButton("intraday", "分时")}
        ${chartModeButton("daily", "日K")}
        ${chartModeButton("boll", "BOLL")}
      </div>
      <section class="detail-chart">
        ${
          marketChartMode === "intraday"
            ? renderIntradayChart(marketDetail.intraday, false)
            : renderCandleChart(marketDetail.daily, marketChartMode === "boll")
        }
        <div class="chart-tooltip" data-chart-tooltip hidden aria-hidden="true"></div>
      </section>
      ${renderMarketDetailStats(marketDetail)}
      ${series.error ? `<div class="chart-warning">${escapeHtml(series.error)}</div>` : ""}
    </div>
  `;
}

function chartModeButton(mode: "intraday" | "daily" | "boll", label: string): string {
  return `<button class="${marketChartMode === mode ? "active" : ""}" data-action="chart-mode" data-mode="${mode}">${label}</button>`;
}

function renderIntradayChart(series: MarketSeries<IntradayPoint>, compact: boolean): string {
  const items = series.items.filter((item) => Number.isFinite(item.price));
  if (items.length === 0) return `<div class="chart-empty">暂无分时数据</div>`;
  const width = 340;
  const height = compact ? 92 : 220;
  const top = 10;
  const bottom = compact ? 8 : 24;
  const prices = items.map((item) => item.price);
  const averages = items.flatMap((item) => (item.average == null ? [] : [item.average]));
  const low = Math.min(...prices, ...averages);
  const high = Math.max(...prices, ...averages);
  const padding = Math.max((high - low) * 0.08, Math.abs(high) * 0.001, 0.01);
  const min = low - padding;
  const max = high + padding;
  const chartHeight = height - top - bottom;
  const x = (index: number) =>
    items.length === 1 ? width / 2 : (index / (items.length - 1)) * width;
  const y = (value: number) => top + ((max - value) / (max - min || 1)) * chartHeight;
  const pricePoints = items
    .map((item, index) => `${x(index).toFixed(1)},${y(item.price).toFixed(1)}`)
    .join(" ");
  const averagePoints = items
    .flatMap((item, index) =>
      item.average == null ? [] : [`${x(index).toFixed(1)},${y(item.average).toFixed(1)}`]
    )
    .join(" ");
  const firstTime = formatTime(items[0]!.time);
  const lastTime = formatTime(items.at(-1)!.time);
  const hoverAttributes = compact
    ? ""
    : `data-chart-kind="intraday" data-chart-width="${width}" data-chart-min="${min}" data-chart-max="${max}" data-chart-top="${top}" data-chart-bottom="${top + chartHeight}"`;
  return `
    <svg class="market-chart intraday-chart" ${hoverAttributes} viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="分时图">
      <line class="chart-grid" x1="0" x2="${width}" y1="${y((max + min) / 2)}" y2="${y((max + min) / 2)}" />
      ${averagePoints ? `<polyline class="average-line" points="${averagePoints}" />` : ""}
      <polyline class="price-line" points="${pricePoints}" />
      ${compact ? "" : renderChartCrosshair(top, top + chartHeight, width)}
      ${compact ? "" : `<text class="chart-label" x="2" y="10">${formatNumber(max)}</text><text class="chart-label" x="2" y="${height - 3}">${firstTime}</text><text class="chart-label end" x="338" y="${height - 3}">${lastTime}</text>`}
    </svg>
  `;
}

function renderCandleChart(series: MarketSeries<DailyCandle>, showBoll: boolean): string {
  const items = series.items.slice(-45);
  if (items.length === 0) return `<div class="chart-empty">暂无日K数据</div>`;
  const width = 340;
  const height = 230;
  const priceTop = 12;
  const priceBottom = 168;
  const volumeTop = 184;
  const volumeBottom = 216;
  const dateLabelY = chartBottomLabelY(height);
  const rangeValues = items.flatMap((item) => [
    item.low,
    item.high,
    ...(showBoll && item.bollLower != null ? [item.bollLower] : []),
    ...(showBoll && item.bollUpper != null ? [item.bollUpper] : [])
  ]);
  const min = Math.min(...rangeValues);
  const max = Math.max(...rangeValues);
  const y = (value: number) =>
    priceTop + ((max - value) / (max - min || 1)) * (priceBottom - priceTop);
  const step = width / items.length;
  const candleWidth = Math.max(2, Math.min(5, step * 0.62));
  const maxVolume = Math.max(...items.map((item) => item.volume), 1);
  const x = (index: number) => step * index + step / 2;
  const candles = items
    .map((item, index) => {
      const direction = item.close >= item.open ? "up" : "down";
      const bodyTop = y(Math.max(item.open, item.close));
      const bodyBottom = y(Math.min(item.open, item.close));
      const volumeHeight = (item.volume / maxVolume) * (volumeBottom - volumeTop);
      return `<g class="candle ${direction}"><line x1="${x(index)}" x2="${x(index)}" y1="${y(item.high)}" y2="${y(item.low)}"/><rect x="${x(index) - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${Math.max(1, bodyBottom - bodyTop)}"/><rect class="volume" x="${x(index) - candleWidth / 2}" y="${volumeBottom - volumeHeight}" width="${candleWidth}" height="${Math.max(1, volumeHeight)}"/></g>`;
    })
    .join("");
  const boll = showBoll
    ? [
        bollPolyline(items, "bollUpper", x, y, "boll-upper"),
        bollPolyline(items, "bollMid", x, y, "boll-mid"),
        bollPolyline(items, "bollLower", x, y, "boll-lower")
      ].join("")
    : "";
  return `
    <svg class="market-chart candle-chart" data-chart-kind="${showBoll ? "boll" : "daily"}" data-chart-width="${width}" data-chart-min="${min}" data-chart-max="${max}" data-chart-top="${priceTop}" data-chart-bottom="${priceBottom}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${showBoll ? "布林线日K图" : "日K图"}">
      <line class="chart-grid" x1="0" x2="${width}" y1="${priceBottom}" y2="${priceBottom}" />
      <line class="chart-grid" x1="0" x2="${width}" y1="${volumeTop}" y2="${volumeTop}" />
      ${candles}${boll}
      ${renderChartCrosshair(priceTop, volumeBottom, width)}
      <text class="chart-label" x="2" y="10">${formatNumber(max)}</text>
      <text class="chart-label" x="2" y="${priceBottom - 3}">${formatNumber(min)}</text>
      <text class="chart-label" x="2" y="${dateLabelY}">${items[0]!.date.slice(5)}</text>
      <text class="chart-label end" x="338" y="${dateLabelY}">${items.at(-1)!.date.slice(5)}</text>
    </svg>
  `;
}

function renderChartCrosshair(top: number, bottom: number, width: number): string {
  return `<g class="chart-crosshair" aria-hidden="true"><line class="chart-crosshair-line" data-crosshair-x y1="${top}" y2="${bottom}"/><line class="chart-crosshair-line" data-crosshair-y x1="0" x2="${width}"/><circle class="chart-crosshair-point" data-crosshair-point r="2.6"/></g>`;
}

function bollPolyline(
  items: DailyCandle[],
  field: "bollUpper" | "bollMid" | "bollLower",
  x: (index: number) => number,
  y: (value: number) => number,
  className: string
): string {
  const points = items
    .flatMap((item, index) =>
      item[field] == null ? [] : [`${x(index).toFixed(1)},${y(item[field]!).toFixed(1)}`]
    )
    .join(" ");
  return points ? `<polyline class="boll-line ${className}" points="${points}" />` : "";
}

function renderMarketDetailStats(detail: MarketDetail): string {
  if (marketChartMode === "intraday") {
    const items = detail.intraday.items;
    const first = items[0]?.price;
    const latest = items.at(-1)?.price;
    const change = first && latest ? ((latest - first) / first) * 100 : null;
    return `<div class="chart-stats"><span><small>最新</small><strong>${formatNumber(latest)}</strong></span><span class="${numberDirection(change)}"><small>分时变化</small><strong>${formatPercent(change)}</strong></span><span><small>数据点</small><strong>${items.length}</strong></span></div>`;
  }
  const latest = detail.daily.items.at(-1);
  if (!latest) return "";
  return `<div class="chart-stats"><span><small>开</small><strong>${formatNumber(latest.open)}</strong></span><span><small>高/低</small><strong>${formatNumber(latest.high)} / ${formatNumber(latest.low)}</strong></span><span><small>收</small><strong>${formatNumber(latest.close)}</strong></span></div>`;
}

interface ChartTooltipRow {
  label: string;
  value: string;
  direction?: string;
}

interface ChartPointerPosition {
  clientX: number;
  clientY: number;
  kind: string;
}

function handleChartPointerMove(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || !marketDetail) {
    hideChartHover();
    return;
  }
  const chart = target.closest<SVGSVGElement>(".market-chart[data-chart-kind]");
  if (!chart) {
    hideChartHover();
    return;
  }
  chartPointerPosition = {
    clientX: event.clientX,
    clientY: event.clientY,
    kind: chart.dataset.chartKind ?? ""
  };
  updateChartHover(chart, event.clientX, event.clientY);
}

function restoreChartHover(): void {
  if (!chartPointerPosition) return;
  if (!marketDetail) {
    chartPointerPosition = null;
    return;
  }
  const chart = rootElement.querySelector<SVGSVGElement>(".market-chart[data-chart-kind]");
  if (!chart || chart.dataset.chartKind !== chartPointerPosition.kind) {
    chartPointerPosition = null;
    return;
  }
  const rect = chart.getBoundingClientRect();
  const { clientX, clientY } = chartPointerPosition;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    hideChartHover();
    return;
  }
  updateChartHover(chart, clientX, clientY);
}

function updateChartHover(chart: SVGSVGElement, clientX: number, clientY: number): void {
  if (!marketDetail) return;
  const container = chart.closest<HTMLElement>(".detail-chart");
  const tooltip = container?.querySelector<HTMLElement>("[data-chart-tooltip]");
  if (!container || !tooltip) return;

  const kind = chart.dataset.chartKind;
  const chartWidth = Number(chart.dataset.chartWidth);
  const min = Number(chart.dataset.chartMin);
  const max = Number(chart.dataset.chartMax);
  const top = Number(chart.dataset.chartTop);
  const bottom = Number(chart.dataset.chartBottom);
  if (![chartWidth, min, max, top, bottom].every(Number.isFinite)) return;

  const rect = chart.getBoundingClientRect();
  if (rect.width <= 0) return;
  const localX = ((clientX - rect.left) / rect.width) * chartWidth;
  let pointX: number;
  let pointY: number;
  let rows: ChartTooltipRow[];

  if (kind === "intraday") {
    const items = marketDetail.intraday.items.filter((item) => Number.isFinite(item.price));
    const index = nearestChartPointIndex(localX, chartWidth, items.length, "edges");
    const item = items[index];
    if (!item) return;
    const change = priceChange(item.price, marketDetail.previousClose);
    pointX = chartPointX(index, chartWidth, items.length, "edges");
    pointY = chartValueY(item.price, min, max, top, bottom);
    const direction = numberDirection(change.amount);
    rows = [
      { label: "时间", value: formatTime(item.time) },
      { label: "现价", value: formatNumber(item.price) },
      { label: "涨跌额", value: formatSignedPrice(change.amount), direction },
      { label: "涨跌幅", value: formatPercent(change.percent), direction },
      { label: "均价", value: formatNumber(item.average) },
      { label: "成交量", value: formatCompact(item.volume, "手") },
      { label: "成交额", value: formatCompact(item.amount, "元") }
    ];
  } else if (kind === "daily" || kind === "boll") {
    const allItems = marketDetail.daily.items;
    const items = allItems.slice(-45);
    const layout: ChartPointLayout = "centers";
    const index = nearestChartPointIndex(localX, chartWidth, items.length, layout);
    const item = items[index];
    if (!item) return;
    const fullIndex = allItems.length - items.length + index;
    const change = priceChange(item.close, allItems[fullIndex - 1]?.close);
    pointX = chartPointX(index, chartWidth, items.length, layout);
    pointY = chartValueY(item.close, min, max, top, bottom);
    const direction = numberDirection(change.amount);
    rows = [
      { label: "日期", value: item.date },
      { label: "开盘", value: formatNumber(item.open) },
      { label: "最高", value: formatNumber(item.high) },
      { label: "最低", value: formatNumber(item.low) },
      { label: "收盘", value: formatNumber(item.close) },
      { label: "涨跌额", value: formatSignedPrice(change.amount), direction },
      { label: "涨跌幅", value: formatPercent(change.percent), direction },
      { label: "成交量", value: formatCompact(item.volume, "手") }
    ];
    if (kind === "boll") {
      rows.push(
        { label: "上轨", value: formatNumber(item.bollUpper) },
        { label: "中轨", value: formatNumber(item.bollMid) },
        { label: "下轨", value: formatNumber(item.bollLower) }
      );
    }
  } else {
    return;
  }

  updateChartCrosshair(chart, pointX, pointY);
  showChartTooltip(container, tooltip, clientX, clientY, rows);
}

function updateChartCrosshair(chart: SVGSVGElement, x: number, y: number): void {
  const vertical = chart.querySelector<SVGLineElement>("[data-crosshair-x]");
  const horizontal = chart.querySelector<SVGLineElement>("[data-crosshair-y]");
  const point = chart.querySelector<SVGCircleElement>("[data-crosshair-point]");
  vertical?.setAttribute("x1", String(x));
  vertical?.setAttribute("x2", String(x));
  horizontal?.setAttribute("y1", String(y));
  horizontal?.setAttribute("y2", String(y));
  point?.setAttribute("cx", String(x));
  point?.setAttribute("cy", String(y));
  chart.classList.add("is-hovering");
}

function showChartTooltip(
  container: HTMLElement,
  tooltip: HTMLElement,
  clientX: number,
  clientY: number,
  rows: ChartTooltipRow[]
): void {
  tooltip.innerHTML = rows
    .map(
      (row) =>
        `<span>${escapeHtml(row.label)}</span><strong class="${escapeAttr(row.direction ?? "")}">${escapeHtml(row.value)}</strong>`
    )
    .join("");
  tooltip.hidden = false;
  tooltip.setAttribute("aria-hidden", "false");

  const containerRect = container.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const pointerX = clientX - containerRect.left;
  const pointerY = clientY - containerRect.top;
  let left = pointerX + 10;
  if (left + tooltipRect.width > containerRect.width - 4) {
    left = pointerX - tooltipRect.width - 10;
  }
  const maxLeft = Math.max(4, containerRect.width - tooltipRect.width - 4);
  const maxTop = Math.max(4, containerRect.height - tooltipRect.height - 4);
  tooltip.style.left = `${Math.min(maxLeft, Math.max(4, left))}px`;
  tooltip.style.top = `${Math.min(maxTop, Math.max(4, pointerY - tooltipRect.height / 2))}px`;
}

function hideChartHover(): void {
  chartPointerPosition = null;
  rootElement
    .querySelectorAll<SVGSVGElement>(".market-chart.is-hovering")
    .forEach((chart) => chart.classList.remove("is-hovering"));
  rootElement.querySelectorAll<HTMLElement>("[data-chart-tooltip]").forEach((tooltip) => {
    tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
  });
}

function marketDetailAttributes(
  kind: MarketInstrumentRequest["kind"],
  market: string | undefined,
  code: string
): string {
  if (market !== "SH" && market !== "SZ" && market !== "BJ") return "";
  return `data-action="market-detail" data-kind="${kind}" data-market="${market}" data-code="${escapeAttr(code)}"`;
}

async function openMarketDetail(
  request: MarketInstrumentRequest,
  background = false
): Promise<void> {
  marketDetailRequest = request;
  const requestId = ++marketDetailRequestId;
  if (!background) {
    marketDetail = null;
    marketDetailLoading = true;
    marketDetailError = null;
    marketChartMode = "intraday";
    render(snapshot);
  }
  try {
    const detail = await window.floatingStock?.getMarketDetail(request);
    if (requestId !== marketDetailRequestId || !marketDetailRequest) return;
    if (!detail) throw new Error("市场数据接口未就绪");
    marketDetail = detail;
    marketDetailError = null;
  } catch (error) {
    if (requestId !== marketDetailRequestId) return;
    marketDetailError = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === marketDetailRequestId) {
      marketDetailLoading = false;
      render(snapshot);
      scheduleMarketDetailRefresh();
    }
  }
}

function scheduleMarketDetailRefresh(): void {
  if (marketDetailRefreshTimer != null) window.clearTimeout(marketDetailRefreshTimer);
  if (!marketDetailRequest) return;
  marketDetailRefreshTimer = window.setTimeout(() => {
    if (marketDetailRequest) void openMarketDetail(marketDetailRequest, true);
  }, 30_000);
}

function closeMarketDetail(shouldRender = true): void {
  marketDetailRequestId += 1;
  marketDetailRequest = null;
  marketDetail = null;
  marketDetailLoading = false;
  marketDetailError = null;
  if (marketDetailRefreshTimer != null) window.clearTimeout(marketDetailRefreshTimer);
  marketDetailRefreshTimer = null;
  if (shouldRender) render(snapshot);
}

function shortIndexName(value: string): string {
  return value.replace("指数", "").replace("成指", "");
}

function dataSourceLabel(source: MarketSeries<unknown>["source"]): string {
  if (source === "eastmoney") return "东财";
  if (source === "tencent") return "腾讯";
  if (source === "mixed") return "双源";
  if (source === "local") return "缓存";
  return "等待";
}

function formatInteger(value: number | null): string {
  return value == null ? "--" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatMarketAmount(value: number | null): string {
  if (value == null) return "--";
  if (Math.abs(value) >= 1_000_000_000_000) return (value / 1_000_000_000_000).toFixed(2) + "万亿";
  if (Math.abs(value) >= 100_000_000) return (value / 100_000_000).toFixed(0) + "亿";
  return formatCompact(value, "元");
}
function renderNews(next: AppSnapshot, maxItems: number, mode: TabConfig["newsMode"]): string {
  const trackedCodes = new Set([
    ...next.settings.holdings.map((holding) => holding.securityCode),
    ...next.settings.watchlist.map((item) => item.securityCode)
  ]);
  const items = next.news
    .filter(
      (item) =>
        mode !== "important" || importantDriverDecision(item, item.analysis, trackedCodes).display
    )
    .slice(0, maxItems);
  const hasAi = items.some((item) => item.analysis?.provider === "ai");
  const analyzer = hasAi
    ? "AI筛选"
    : next.ai.configured && next.ai.state === "error"
      ? "AI异常 · 规则降级"
      : "本地规则";

  if (items.length === 0) {
    const detail =
      next.ai.enabled && !next.ai.configured
        ? "未配置 API Key；当前只使用本地规则。"
        : "没有高价值事件时保持安静。";
    return `
      <div class="empty-state">
        <strong>暂无重要驱动</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
    `;
  }

  return `
    <div class="section-caption">
      <span>潜在股价驱动</span>
      <em>${escapeHtml(analyzer)}</em>
    </div>
    <div class="scroll-list news-list driver-list">
      ${items
        .map((item) => {
          const analysis = item.analysis;
          const cue = decisionCueForItem(item, next);
          const related = analysis?.relatedCodes.length
            ? analysis.relatedCodes.join(" · ")
            : "未确认标的";
          const materialLimited = analysis?.materialLimited === true;
          const failure =
            analysis?.provider === "rules" && analysis.failureReason
              ? `降级：${analysis.failureReason}`
              : "";
          return `
          <article class="news-item driver-card priority-${analysis?.priority ?? "low"} direction-${analysis?.direction ?? "neutral"}" data-url="${escapeAttr(item.url)}" title="${escapeAttr(item.title)}">
            <span class="news-time">${formatTime(item.publishedAt)}</span>
            <span class="driver-heading">
              <strong>${escapeHtml(analysis?.summary ?? item.title)}</strong>
              <em class="attention-${cue.level}">${escapeHtml(cue.label)}</em>
            </span>
            <span class="driver-meta">
              ${escapeHtml(sourceLabel(item.source))}
              · ${escapeHtml(sourceTierLabel(item.sourceTier))}
              ${
                item.documentCount && item.documentCount > 1
                  ? ` · 已合并 ${item.documentCount} 份材料`
                  : ""
              }
              · ${escapeHtml(related)}
              · ${escapeHtml(relationLabel(analysis))}
              · ${escapeHtml(eventTypeLabel(analysis?.eventType))}
              · ${escapeHtml(horizonLabel(analysis?.horizon))}
              · ${escapeHtml(directionLabel(analysis?.direction))}
              · 重要度 ${analysis?.importance ?? "--"}
              · 综合可信 ${analysis?.confidence ?? "--"}
              ${materialLimited ? " · 材料有限" : ""}
            </span>
            <span class="news-mechanism">影响：${escapeHtml(analysis?.mechanism ?? item.summary ?? "尚未形成传导判断")}</span>
            <span class="decision-market">当前：${escapeHtml(cue.marketResponse)}</span>
            <span class="decision-uncertainty">不确定：${escapeHtml(cue.uncertainty)}</span>
            <span class="decision-next">
              <span>下一步：${escapeHtml(cue.nextStep)}</span>
              <button type="button" class="driver-context" data-action="copy-news-context" data-event-id="${escapeAttr(item.eventId ?? item.id)}">复制给 Coze</button>
            </span>
            ${failure ? `<span class="driver-fallback">${escapeHtml(failure)}</span>` : ""}
          </article>
        `;
        })
        .join("")}
    </div>
  `;
}

function decisionCueForItem(item: AppSnapshot["news"][number], next: AppSnapshot) {
  const holdingCodes = new Set(next.settings.holdings.map((holding) => holding.securityCode));
  const watchlistCodes = new Set(next.settings.watchlist.map((entry) => entry.securityCode));
  const preliminary = buildDecisionCue({
    item,
    analysis: item.analysis,
    holdingCodes,
    watchlistCodes,
    quoteChangePercent: null,
    benchmarkChangePercent: null,
    recentRuleTriggered: false
  });
  const quote = preliminary.relatedCode
    ? next.quotes.find((entry) => entry.code === preliminary.relatedCode)
    : undefined;
  const benchmarkCode = benchmarkCodeForSecurity(preliminary.relatedCode ?? "600000");
  const benchmark = next.market.indices.find((entry) => entry.instrument.code === benchmarkCode);
  const recentRuleTriggered = Boolean(
    preliminary.relatedCode &&
    next.risk.recentEvents.some(
      (event) =>
        event.securityCode === preliminary.relatedCode &&
        Date.now() - Date.parse(event.triggeredAt) <= 30 * 60_000
    )
  );
  return buildDecisionCue({
    item,
    analysis: item.analysis,
    holdingCodes,
    watchlistCodes,
    quoteChangePercent: quote?.changePercent ?? null,
    benchmarkChangePercent: benchmark?.changePercent ?? null,
    recentRuleTriggered
  });
}

function directionLabel(value: string | undefined): string {
  if (value === "positive") return "偏正面";
  if (value === "negative") return "偏负面";
  if (value === "mixed") return "多空混合";
  if (value === "neutral") return "中性";
  return "方向待定";
}

function eventTypeLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    earnings: "业绩",
    policy: "政策",
    order: "订单",
    management: "管理层",
    capital: "资本事项",
    industry: "行业",
    market: "市场",
    other: "其他"
  };
  return value ? (labels[value] ?? "其他") : "未分类";
}

function relationLabel(analysis: AppSnapshot["news"][number]["analysis"]): string {
  if (!analysis) return "关联待确认";
  if (analysis.relation === "direct" && analysis.sourceRelatedCodes.length) {
    return "正文直接关联";
  }
  if (
    analysis.relation === "industry" &&
    analysis.inferredRelatedCodes.length &&
    !analysis.sourceRelatedCodes.length
  ) {
    return "AI推测行业关联";
  }
  if (analysis.relation === "industry") return "行业关联";
  if (analysis.relation === "market") return "全市场";
  return "关联待确认";
}

function sourceLabel(value: string): string {
  if (/eastmoney|东方财富/i.test(value)) return "东财快讯";
  if (value === "cninfo") return "巨潮公告";
  if (value === "sse") return "上交所公告";
  if (value === "szse") return "深交所公告";
  if (value === "bse") return "北交所公告";
  if (value === "csrc") return "证监会";
  return value || "来源未知";
}

function sourceTierLabel(value: AppSnapshot["news"][number]["sourceTier"]): string {
  if (value === "official") return "法定披露";
  if (value === "regulatory") return "监管政策";
  return "媒体线索";
}

function horizonLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    intraday: "日内",
    short: "短期",
    medium: "中期",
    long: "长期"
  };
  return value ? (labels[value] ?? "周期待定") : "周期待定";
}

function renderQuote(code: string, quote: Quote | undefined, settings: UserSettings): string {
  const security = securityFor(settings, code);
  const displayName = security?.alias || security?.name || quote?.name || code;
  const detailName =
    security?.alias && (security.name || quote?.name) ? (security.name || quote?.name) + " · " : "";
  const direction = quoteDirection(quote);

  return `
    <article class="quote-row ${direction}" data-stock-code="${escapeAttr(code)}" tabindex="0" ${marketDetailAttributes("stock", security?.market ?? quote?.market, code)}>
      <div class="quote-name">
        <strong>${escapeHtml(displayName)}</strong>
        <span>${escapeHtml(detailName)}${security?.market ?? quote?.market ?? ""}.${code}${renderQuoteQuality(quote)}</span>
      </div>
      <div class="quote-metrics">
        ${settings.quotes.fields.map((field) => renderQuoteField(quote, field)).join("")}
      </div>
    </article>
  `;
}

function renderQuoteField(quote: Quote | undefined, field: QuoteField): string {
  return `
    <span class="quote-metric">
      <small>${fieldLabels[field]}</small>
      <strong>${formatQuoteField(quote, field)}</strong>
    </span>
  `;
}

function watchlistCodes(settings: UserSettings): string[] {
  return visibleWatchlistCodes(settings);
}

function sortCodes(codes: string[], quotes: Quote[], settings: UserSettings): string[] {
  const unique = [...new Set(codes)];
  const quoteMap = new Map(quotes.map((quote) => [quote.code, quote]));
  if (settings.quotes.sort === "changePercentDesc") {
    return unique.sort(
      (a, b) =>
        (quoteMap.get(b)?.changePercent ?? -Infinity) -
        (quoteMap.get(a)?.changePercent ?? -Infinity)
    );
  }
  if (settings.quotes.sort === "changePercentAbs") {
    return unique.sort(
      (a, b) =>
        Math.abs(quoteMap.get(b)?.changePercent ?? 0) -
        Math.abs(quoteMap.get(a)?.changePercent ?? 0)
    );
  }
  return unique;
}

function securityFor(settings: UserSettings, code: string) {
  return settings.securities.find((security) => security.code === code);
}

function applyAppearance(settings: UserSettings): void {
  document.documentElement.dataset.theme = settings.appearance.theme;
  document.documentElement.style.setProperty(
    "--widget-opacity",
    String(settings.appearance.backgroundOpacity)
  );
}

// 事件回调必须返回 void：把异步逻辑放进具名函数，并用 void 显式标记忽略返回的 Promise，
// 否则既触发 no-misused-promises，也会让 rejection 变成无人处理的悬挂 Promise。
rootElement.addEventListener("click", (event) => {
  void handleRootClick(event);
});
function openStockMenu(row: HTMLElement, x: number, y: number): void {
  if (stockMenu?.busy || !row.dataset.stockCode) return;
  const code = row.dataset.stockCode;
  const item = snapshot.settings.watchlist.find((entry) => entry.securityCode === code);
  stockMenu = {
    code,
    groupId: selectedWatchlistGroup,
    x,
    y,
    editing: false,
    ids: item ? [...membershipGroupIds(item)] : [],
    busy: false,
    message: ""
  };
  renderStockMenu();
  document.querySelector<HTMLButtonElement>("#stock-context-menu button")?.focus();
}
rootElement.addEventListener("contextmenu", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(
    ".watchlist-page [data-stock-code]"
  );
  if (!row) return;
  event.preventDefault();
  openStockMenu(row, event.clientX, event.clientY);
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest("#stock-context-menu")) closeStockMenu();
});
window.addEventListener("blur", closeStockMenu);
rootElement.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (!stockMenu || stockMenu.busy || input.dataset.stockGroup === undefined) return;
  stockMenu.ids = input.checked
    ? [...new Set([...stockMenu.ids, input.dataset.stockGroup])]
    : stockMenu.ids.filter((id) => id !== input.dataset.stockGroup);
});
rootElement.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "stock-query") stockQuery = input.value;
  updateHoldingDraft(input);
});
rootElement.addEventListener("compositionstart", (event) => {
  if ((event.target as HTMLElement).dataset.holdingField) holdingComposing = true;
});
rootElement.addEventListener("compositionend", (event) => {
  if ((event.target as HTMLElement).dataset.holdingField) {
    holdingComposing = false;
    updateHoldingDraft(event.target as HTMLInputElement);
  }
});
rootElement.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && stockMenu) {
    event.preventDefault();
    closeStockMenu();
    return;
  }
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      ".watchlist-page [data-stock-code]"
    );
    if (row) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openStockMenu(row, rect.left + 12, rect.top + 12);
      return;
    }
  }
  if (event.key === "Escape" && holdingDraft && !holdingEditBusy && !event.isComposing) {
    holdingDraft = null;
    holdingEditMessage = "";
    render(snapshot);
  }
});
rootElement.addEventListener("submit", (event) => {
  if ((event.target as HTMLElement).matches(".holding-editor")) {
    event.preventDefault();
    void saveHoldingEdit();
    return;
  }
  if ((event.target as HTMLElement).matches(".stock-search-form")) {
    event.preventDefault();
    void searchStocks();
  }
});
rootElement.addEventListener("pointermove", handleChartPointerMove);
rootElement.addEventListener("pointerleave", hideChartHover);

async function handleRootClick(event: MouseEvent): Promise<void> {
  const control = (event.target as HTMLElement).closest<HTMLElement>("[data-action], [data-url]");
  if (!control) return;

  if (control.closest("#stock-context-menu")) {
    if (stockMenu?.busy) return;
    if (control.dataset.action === "close-stock-menu") closeStockMenu();
    if (control.dataset.action === "edit-stock-groups" && stockMenu) {
      stockMenu.editing = true;
      renderStockMenu();
    }
    if (control.dataset.action === "save-stock-groups") await manageStock("groups");
    if (
      control.dataset.action === "remove-stock-current" &&
      !(control as HTMLButtonElement).disabled
    )
      await manageStock("remove-current");
    if (control.dataset.action === "remove-stock-all" && !(control as HTMLButtonElement).disabled)
      await manageStock("remove-all");
    return;
  }
  if (control.dataset.action === "edit-holding") {
    if (holdingEditBusy || holdingDraft) return;
    const holding = snapshot.settings.holdings.find(
      (item) => item.securityCode === control.dataset.code
    );
    if (holding) {
      holdingDraft = createHoldingEditDraft(holding);
      holdingEditMessage = "";
      render(snapshot);
      document.getElementById("holding-edit-quantity")?.focus();
    }
    return;
  }
  if (control.dataset.action === "cancel-holding-edit") {
    if (!holdingEditBusy) {
      holdingDraft = null;
      holdingEditMessage = "";
      render(snapshot);
    }
    return;
  }
  if (control.dataset.action === "watchlist-group") {
    selectedWatchlistGroup = control.dataset.groupId ?? "";
    render(snapshot);
    rootElement.querySelector<HTMLElement>(".quote-list")?.scrollTo({ top: 0 });
    return;
  }
  if (control.dataset.action === "close-stock-search") {
    if (stockBusy) return;
    stockSearchVersion += 1;
    stockBusy = false;
    stockMessage = "";
    stockResults = [];
    render(snapshot);
    return;
  }
  if (control.dataset.action === "add-watch-stock") {
    await addWatchStock(Number(control.dataset.index));
    return;
  }
  if (control.dataset.action === "tab" && control.dataset.tabId) {
    await activateTab(control.dataset.tabId);
    return;
  }
  if (control.dataset.action === "market-detail") {
    const kind = control.dataset.kind === "index" ? "index" : "stock";
    const market = control.dataset.market;
    const code = control.dataset.code;
    if (code && (market === "SH" || market === "SZ" || market === "BJ")) {
      await openMarketDetail({ kind, market, code });
    }
    return;
  }
  if (control.dataset.action === "market-back") {
    closeMarketDetail();
    return;
  }
  if (control.dataset.action === "alerts-pause") {
    await window.floatingStock?.pauseAlertsToday();
    return;
  }
  if (control.dataset.action === "alerts-resume") {
    await window.floatingStock?.resumeAlerts();
    return;
  }
  if (control.dataset.action === "chart-mode") {
    const mode = control.dataset.mode;
    if (mode === "intraday" || mode === "daily" || mode === "boll") {
      marketChartMode = mode;
      render(snapshot);
    }
    return;
  }
  if (control.dataset.action === "hide") {
    await window.floatingStock?.hideWindow();
    return;
  }
  if (control.dataset.action === "settings") {
    await window.floatingStock?.openSettings();
    return;
  }
  if (control.dataset.action === "theme") {
    await window.floatingStock?.toggleTheme();
    return;
  }

  if (control.dataset.action === "click-through") {
    const requested = !clickThrough;
    clickThrough = requested;
    try {
      await window.floatingStock?.toggleClickThrough(requested);
      // 成功后立刻重绘：否则按钮的 active/aria-pressed 会停在旧值，直到下一次快照推送
      // （审计报告 §4-8：同一个事实在模块变量、主进程配置与 DOM 里有三份拷贝）。
      render(snapshot);
    } catch {
      // 回滚乐观更新，避免按钮 aria-pressed 与实际点击穿透状态不一致。
      clickThrough = !requested;
      render(snapshot);
    }
    return;
  }
  if (control.dataset.action === "copy-news-context" && control.dataset.eventId) {
    const original = control.textContent;
    try {
      await window.floatingStock?.copyNewsContext(control.dataset.eventId);
      control.textContent = "已复制";
    } catch {
      control.textContent = "复制失败";
    }
    // 保存句柄：下一次 render() 会替换该节点，必须先取消定时器，
    // 否则回调会写到一个已脱离文档的元素上（用户看不到任何变化）。
    if (copyFeedbackTimer != null) window.clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = window.setTimeout(() => {
      copyFeedbackTimer = null;
      control.textContent = original;
    }, 1_500);
    return;
  }

  const url = control.dataset.url;
  if (url) await window.floatingStock?.openExternal(url);
}

rootElement.addEventListener("change", (event) => {
  void handleRootChange(event);
});

async function handleRootChange(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  updateHoldingDraft(select);
  if (select.dataset.action === "tab-overflow" && select.value) {
    await activateTab(select.value);
  }
}

async function activateTab(tabId: string): Promise<void> {
  closeMarketDetail(false);
  activeTabId = tabId;
  render(snapshot);
  await window.floatingStock?.setActiveTab(tabId);
}

if (!window.floatingStock) {
  // preload 桥接没装好时，此前所有 `?.` 都会静默跳过 → 部件永远停在 emptySnapshot，
  // 既不报错也不重试（审计报告 §4-4）。这里至少让用户看到"为什么是空的"。
  rootElement.innerHTML =
    '<main class="window-shell"><p class="bridge-error">无法连接到应用主进程：请重启摸鱼看盘；若仍然如此，请从托盘退出后重新打开。</p></main>';
} else {
  // 边界自检：主进程改字段名时，渲染层读到的会是 undefined（状态栏反而显示"正常"），
  // 类型系统在 `ipcRenderer.invoke` 这条 any 通道上不会报错，所以这里显式查一次（§4-4）。
  let reportedShapeProblem: string | null = null;
  const acceptSnapshot = (value: unknown): void => {
    const problem = describeAppSnapshotProblem(value);
    if (problem) {
      if (problem !== reportedShapeProblem) {
        reportedShapeProblem = problem;
        shapeProblem = problem;
        render(value as AppSnapshot);
      }
      return;
    }
    shapeProblem = null;
    render(value as AppSnapshot);
  };
  void window.floatingStock.getSnapshot().then(acceptSnapshot);
  window.floatingStock.onSnapshot(acceptSnapshot);
  render(emptySnapshot);
}
window.addEventListener("online", () => {
  void window.floatingStock?.notifyOnline();
});

/**
 * IPC 载荷形状不对时的可见提示（§4-4）。
 *
 * 以前字段改名会让状态栏读到一堆 `undefined` 并显示"一切正常"；这里把第一处问题
 * 直接写出来，用户和开发者都能立刻看到是哪条通道坏了。
 */
function renderShapeProblem(): string {
  if (!shapeProblem) return "";
  return `<section class="alert-banner active" role="alert"><span>!</span><strong>数据格式异常</strong><em>${escapeHtml(shapeProblem)}</em></section>`;
}

function renderRecentAlert(next: AppSnapshot): string {
  const event = next.risk.recentEvents[0];
  if (!event) return "";
  const age = Date.now() - Date.parse(event.triggeredAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60_000) return "";
  if (event.mode === "active" && !next.settings.risk.notifications.widget) return "";
  return `
    <section class="alert-banner ${event.mode}">
      <span>${event.mode === "shadow" ? "影子" : "提醒"}</span>
      <strong>${escapeHtml(event.title)}</strong>
      <em>${escapeHtml(event.message)}</em>
    </section>
  `;
}
function renderErrors(errors: string[]): string {
  if (errors.length === 0) return "";
  return `<section class="status">${errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("")}</section>`;
}

function renderFeedStatus(label: string, status: AppSnapshot["feeds"]["quotes"]): string {
  if (!status.lastSuccessAt) return `<span class="stale">${label}等待</span>`;
  const sourceLabels: Record<string, string> = {
    eastmoney: "东财",
    tencent: "腾讯",
    official: "官方",
    mixed: label === "资讯" ? "多源" : "双源",
    local: "缓存"
  };
  const source = status.source ? " " + (sourceLabels[status.source] ?? status.source) : "";
  const states: string[] = [];
  const marketLabels = {
    preopen: "盘前",
    lunch: "午休",
    closed: "休市",
    holiday: "节休",
    weekend: "周末"
  } as const;
  if (status.marketState && status.marketState !== "trading") {
    states.push(marketLabels[status.marketState]);
  }
  if (status.stalled) states.push("停滞");
  else if (status.stale) states.push("延迟");
  if (status.conflictCount > 0) states.push(`冲突${status.conflictCount}`);
  if (status.retainedCount > 0) states.push(`缓存${status.retainedCount}`);
  if (status.missingCount > 0) states.push(`缺${status.missingCount}`);
  if (status.degraded && states.length === 0) states.push("降级");
  if (status.coverage != null && status.coverage < 1) {
    states.push(`${Math.round(status.coverage * 100)}%`);
  }
  const staleClass = status.stale || status.stalled || status.degraded ? "stale" : "";
  const stateText = states.length > 0 ? " · " + states.join("/") : "";
  const providerDetails = (status.providerHealth ?? []).map((health) => {
    const circuit =
      health.circuitState === "closed" ? "正常" : health.circuitState === "open" ? "熔断" : "探测";
    const p50 = health.latencyP50Ms == null ? "--" : `${health.latencyP50Ms}ms`;
    const p95 = health.latencyP95Ms == null ? "--" : `${health.latencyP95Ms}ms`;
    return `${sourceLabels[health.provider] ?? health.provider} 成功${Math.round(health.successRate * 100)}% 完整${Math.round(health.completenessRate * 100)}% 新鲜${Math.round(health.freshnessRate * 100)}% P50/P95 ${p50}/${p95} 解析失败${Math.round(health.parseFailureRate * 100)}% 差异${Math.round(health.conflictRate * 100)}% ${circuit}`;
  });
  const details = [
    `最近可信 ${formatFeedTime(status.lastSuccessAt)}`,
    status.dataUpdatedAt ? `源数据 ${formatFeedTime(status.dataUpdatedAt)}` : "源数据时间未知",
    status.lastChangedAt
      ? `数值变化 ${formatFeedTime(status.lastChangedAt)}`
      : "尚未检测到数值变化",
    `价格提醒${status.alertSafe ? "可用" : "已禁用"}`,
    ...providerDetails
  ].join("；");
  return `<span class="${staleClass}" title="${escapeAttr(details)}">${label} ${formatFeedTime(status.lastSuccessAt)}${source}${stateText}</span>`;
}

function renderQuoteQuality(quote: Quote | undefined): string {
  const quality = quote?.quality;
  if (!quality || quality.state === "fresh") return "";
  const labels = {
    fallback: "备用",
    stale: "陈旧",
    retained: "缓存",
    conflict: "冲突"
  } as const;
  const reasons = quality.reasons.length > 0 ? quality.reasons.join(", ") : quality.state;
  return ` <em class="quote-quality quality-${quality.state}" title="${escapeAttr(reasons)}">${labels[quality.state]}</em>`;
}

function quoteDirection(quote: Quote | undefined): string {
  return changeDirection(quote?.changePercent);
}

function numberDirection(value: number | null | undefined): string {
  return changeDirection(value);
}

function formatQuoteField(quote: Quote | undefined, field: QuoteField): string {
  const value = quote?.[field];
  if (field === "change") return formatSigned(value);
  if (field === "changePercent") return formatPercent(value);
  if (field === "volume") return formatCompact(value, "手");
  if (field === "amount" || field === "mainInflow") {
    return formatCompact(value, "元", field === "mainInflow");
  }
  return formatNumber(value);
}

/** 主窗口的价格精度：≤100 保留 3 位（ETF/基金有 3 位报价），>100 用 2 位。 */
function formatNumber(value: number | null | undefined): string {
  return formatFixedOrDash(value, Math.abs(value ?? 0) > 100 ? 2 : 3);
}

function formatSigned(value: number | null | undefined): string {
  if (value == null) return "--";
  return (value > 0 ? "+" : "") + value.toFixed(2);
}

function formatSignedPrice(value: number | null | undefined): string {
  if (value == null) return "--";
  const digits = Math.abs(value) > 100 ? 2 : 3;
  return (value > 0 ? "+" : "") + value.toFixed(digits);
}

function formatPercent(value: number | null | undefined): string {
  return formatSignedPercent(value);
}

function formatRLabel(value: number | null | undefined): string {
  return value == null ? "" : ` · ${value.toFixed(2)}R`;
}
function formatMoney(value: number | null | undefined): string {
  if (value == null) return "--";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatSignedMoney(value: number | null | undefined): string {
  if (value == null) return "--";
  return (
    (value > 0 ? "+" : "") +
    new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: 0
    }).format(value)
  );
}

function formatQuantity(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number | null | undefined, suffix: string, signed = false): string {
  if (value == null) return "--";
  const absolute = Math.abs(value);
  const sign = signed && value > 0 ? "+" : value < 0 ? "-" : "";
  if (absolute >= 100_000_000) return sign + (absolute / 100_000_000).toFixed(1) + "亿";
  if (absolute >= 10_000) return sign + (absolute / 10_000).toFixed(1) + "万";
  return sign + absolute.toFixed(0) + suffix;
}

function formatFeedTime(value: string): string {
  return formatClockTimeWithSeconds(value);
}

function formatTime(value: string): string {
  return formatClockTime(value);
}
