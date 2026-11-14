import type { UserSettings } from "../../config.js";
import type { FloatingStockApi } from "../../global.js";
import type { ThsStatus, ThsPreview, ThsRequest } from "../../services/ths/ledger.js";
import { escapeHtml, escapeAttr } from "../../presentation/format.js";

export class ThsSettingsController {
  status: ThsStatus = { configured: false, selectedId: "", portfolios: [] };
  preview: ThsPreview | null = null;
  busy = "";
  message = "";
  constructor(
    private readonly ports: {
      ipc: () => FloatingStockApi | undefined;
      render: () => void;
      isDirty?: () => boolean;
      apply: (settings: UserSettings) => void;
    }
  ) {}
  async initialize(): Promise<void> {
    try {
      this.status = (await this.ports.ipc()!.thsRequest({ action: "status" })) as ThsStatus;
      if (this.status.configured) {
        this.status = (await this.ports.ipc()!.thsRequest({ action: "list" })) as ThsStatus;
      }
      this.ports.render();
    } catch {
      this.message = this.status.configured
        ? "暂时无法读取账本，请刷新或重新登录。"
        : "同花顺接入未就绪，请重启软件";
      this.ports.render();
    }
  }
  select(id: string): void {
    this.status.selectedId = id;
    this.preview = null;
    this.message = "";
    this.ports.render();
  }
  async refreshSyncStatus(): Promise<void> {
    if (this.busy || document.hidden) return;
    try {
      const status = (await this.ports.ipc()!.thsRequest({ action: "status" })) as ThsStatus;
      this.status.sync = status.sync;
      const element = document.getElementById("ths-sync-status");
      if (element) element.textContent = this.syncStatusText();
    } catch {
      /* The next status poll retries without replacing an in-progress settings draft. */
    }
  }
  private syncStatusText(): string {
    const sync = this.status.sync;
    if (!sync?.enabled) return "自动同步未开启";
    const time = (value: string | null): string =>
      value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
    return `同步账本：${sync.portfolioName}；每 ${sync.intervalSeconds / 60} 分钟同步。最近成功：${time(sync.lastSyncedAt)}；账本上传：${time(sync.uploadedAt)}。${sync.message}`;
  }
  render(): string {
    const disabled = this.busy ? "disabled" : "";
    const time = (value: string | null): string =>
      value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "接口未提供";
    return `<div class="panel-heading"><div><h2>同花顺投资账本</h2><p>登录后选择账本，自动读取股票、数量和成本；交易后请先在同花顺 APP 上传账本。</p></div><span>${this.status.configured ? "已保存登录" : "未登录"}</span></div>
      <div class="ths-actions"><button data-action="ths-login" ${disabled}>${this.busy === "login" ? "等待登录…" : "登录同花顺"}</button>${this.busy === "login" ? '<button data-action="ths-cancel">取消登录</button>' : ""}<button data-action="ths-list" ${disabled} ${this.status.configured ? "" : "disabled"}>刷新账本</button><button data-action="ths-logout" ${disabled} ${this.status.configured ? "" : "disabled"}>退出登录</button></div>
      <details class="ths-manual"><summary>登录窗口不可用？使用浏览器登录凭据</summary><p>在普通浏览器登录投资账本，复制请求中的完整 Cookie。仅加密保存在本机，不进入配置导出。</p><label>登录凭据<input id="ths-cookie" type="password" autocomplete="off" placeholder="粘贴 Cookie，保存后清空" ${disabled}></label><button data-action="ths-cookie" ${disabled}>验证并保存</button></details>
      <div class="ths-selection"><label>选择账本<select id="ths-portfolio" ${disabled}><option value="">请选择账本</option>${this.status.portfolios.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === this.status.selectedId ? "selected" : ""}>${escapeHtml(item.name)}${item.broker ? ` · ${escapeHtml(item.broker)}` : ""}</option>`).join("")}</select></label><button data-action="ths-preview" ${disabled} ${this.status.selectedId ? "" : "disabled"}>读取持仓</button></div>
      <div class="ths-sync"><h3>自动同步持仓</h3><p>开启后自动保存所选账本的数量和成本，并移除已同步但已从账本消失的持仓；其他手工持仓、备注和提醒规则保留。后台同步在设置窗口打开时暂停，关闭后恢复；也可点击“立即同步”直接保存，之后自动同步继续。软件退出后停止运行。</p><div class="ths-actions"><label>同步间隔<select id="ths-sync-interval" ${disabled} ${this.status.sync?.enabled ? "disabled" : ""}>${[60, 300, 900].map((seconds) => `<option value="${seconds}" ${(this.status.sync?.intervalSeconds ?? 60) === seconds ? "selected" : ""}>${seconds / 60} 分钟</option>`).join("")}</select></label><button data-action="ths-sync-now" ${disabled} ${this.status.configured && (this.status.sync?.enabled || this.status.selectedId) ? "" : "disabled"}>${this.busy === "sync-now" ? "同步中…" : this.status.sync?.enabled ? "立即同步" : "同步并开启自动同步"}</button><button data-action="ths-sync-enable" ${disabled} ${this.status.configured && this.status.selectedId && !this.status.sync?.enabled ? "" : "disabled"}>开启所选账本自动同步</button><button data-action="ths-sync-disable" ${disabled} ${this.status.sync?.enabled ? "" : "disabled"}>关闭自动同步</button></div><p id="ths-sync-status" role="status">${escapeHtml(this.syncStatusText())}</p><p>切换自动同步账本需先关闭再开启；原账本的已同步持仓会保留。登录过期或查询失败时保留现有数据。</p></div>
      <p class="ths-message" role="status">${escapeHtml(this.message || (this.busy ? "正在处理，请稍候…" : "读取成功不代表券商实时持仓，请核对账本上传时间。"))}</p>
      ${this.preview ? `<div class="ths-preview"><p><strong>${escapeHtml(this.preview.portfolio.name)}</strong> · ${this.preview.positions.length} 只持仓</p><p>账本上传：${escapeHtml(time(this.preview.uploadedAt))}<br>本次查询：${escapeHtml(time(this.preview.queriedAt))}</p><div class="ths-table-wrap"><table><thead><tr><th>股票</th><th>数量</th><th>成本价</th></tr></thead><tbody>${this.preview.positions.map((item) => `<tr><td>${escapeHtml(item.name)} <small>${item.market}.${item.code}</small></td><td>${item.quantity}</td><td>${item.costPrice}</td></tr>`).join("") || '<tr><td colspan="3">账本明确返回空仓</td></tr>'}</tbody></table></div><label>导入方式<select id="ths-import-mode" ${disabled}><option value="merge">新增或更新，保留本地其他持仓</option><option value="replace">替换全部持仓，以此账本为准</option></select></label><p>相同股票保留本地备注、风险组和提醒规则；新股票默认关闭提醒。自选分组保持不变。</p><button data-action="ths-import" ${disabled}>导入到持仓设置</button></div>` : ""}`;
  }
  async handle(action: string | undefined, settings: UserSettings): Promise<boolean> {
    if (!action?.startsWith("ths-")) return false;
    const api = this.ports.ipc();
    if (!api) return true;
    const kind = action.slice(4);
    if (kind === "cancel") {
      await api.thsRequest({ action: "cancel" });
      return true;
    }
    if (this.busy) return true;
    let request: ThsRequest;
    if (kind === "sync-enable" || kind === "sync-disable" || kind === "sync-now") {
      if (kind !== "sync-disable" && this.ports.isDirty?.()) {
        this.message = "请先保存当前设置，再同步持仓。";
        this.ports.render();
        return true;
      }
      request =
        kind === "sync-now"
          ? {
              action: "sync-now",
              portfolioId: this.status.sync?.enabled
                ? this.status.sync.portfolioId
                : this.status.selectedId,
              intervalSeconds: Number(
                (document.getElementById("ths-sync-interval") as HTMLSelectElement).value
              )
            }
          : {
              action: "sync-configure",
              enabled: kind === "sync-enable",
              portfolioId: this.status.selectedId,
              intervalSeconds: Number(
                (document.getElementById("ths-sync-interval") as HTMLSelectElement).value
              )
            };
    } else if (kind === "cookie") {
      const input = document.getElementById("ths-cookie") as HTMLInputElement;
      request = { action: "cookie", cookie: input.value };
      input.value = "";
    } else if (kind === "preview")
      request = { action: "preview", portfolioId: this.status.selectedId };
    else if (kind === "import") {
      if (!this.preview) return true;
      const mode =
        (document.getElementById("ths-import-mode") as HTMLSelectElement).value === "replace"
          ? "replace"
          : "merge";
      if (
        mode === "replace" &&
        !window.confirm(
          `将使用“${this.preview.portfolio.name}”的 ${this.preview.positions.length} 只持仓替换本地持仓，账本中没有的本地持仓会被移除。是否继续？`
        )
      )
        return true;
      request = { action: "import", token: this.preview.token, mode, settings };
    } else if (kind === "login" || kind === "list" || kind === "logout") request = { action: kind };
    else return true;
    this.busy = kind;
    this.message = "";
    this.ports.render();
    try {
      const result = await api.thsRequest(request);
      if (kind === "preview") {
        this.preview = result as ThsPreview;
        this.message = "请核对数量、成本和上传时间后导入。";
      } else if (kind === "import") {
        this.ports.apply(result as UserSettings);
        this.preview = null;
        this.message = "已导入到持仓设置，点击页面顶部“保存设置”后生效。";
      } else {
        this.status = result as ThsStatus;
        this.preview = null;
        this.message =
          kind === "sync-now"
            ? "持仓已立即同步并保存，后台自动同步将按所设间隔继续运行。"
            : kind === "sync-enable"
              ? "自动同步已开启，关闭设置窗口后开始同步并自动保存持仓。"
              : kind === "sync-disable"
                ? "自动同步已关闭，现有持仓保留。"
                : kind === "logout"
                  ? "已清除本机登录；已导入的持仓保留。"
                  : this.status.portfolios.length
                    ? "请选择账本并读取持仓。"
                    : "当前账户没有可用账本，请先在同花顺投资账本上传数据。";
      }
    } catch (error) {
      this.message = error instanceof Error ? error.message : "同花顺操作失败，请重试";
      if (kind === "sync-now") {
        try {
          this.status = (await api.thsRequest({ action: "status" })) as ThsStatus;
        } catch {
          /* Preserve the original sync error when status is unavailable. */
        }
      }
      if (kind === "preview") this.preview = null;
    } finally {
      this.busy = "";
      this.ports.render();
    }
    return true;
  }
}
