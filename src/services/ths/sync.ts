import type { UserSettings } from "../../config.js";
import { mergeThsHoldings, type ThsPreview } from "./ledger.js";

export interface ThsSyncState {
  enabled: boolean;
  portfolioId: string;
  portfolioName: string;
  intervalSeconds: number;
  managedCodes: string[];
  lastSyncedAt: string | null;
  uploadedAt: string | null;
}
export interface ThsSyncStatus extends Omit<ThsSyncState, "managedCodes"> {
  running: boolean;
  message: string;
}
export function defaultThsSyncState(): ThsSyncState {
  return {
    enabled: false,
    portfolioId: "",
    portfolioName: "",
    intervalSeconds: 60,
    managedCodes: [],
    lastSyncedAt: null,
    uploadedAt: null
  };
}
export function normalizeThsSyncState(value: unknown): ThsSyncState {
  const result = defaultThsSyncState();
  if (!value || typeof value !== "object") return result;
  const raw = value as Record<string, unknown>;
  if (typeof raw.portfolioId !== "string" || !raw.portfolioId || raw.portfolioId.length > 256)
    return result;
  result.portfolioId = raw.portfolioId;
  result.portfolioName =
    typeof raw.portfolioName === "string" ? raw.portfolioName.slice(0, 100) : raw.portfolioId;
  result.intervalSeconds = [60, 300, 900].includes(Number(raw.intervalSeconds))
    ? Number(raw.intervalSeconds)
    : 60;
  result.enabled = raw.enabled === true;
  result.managedCodes = Array.isArray(raw.managedCodes)
    ? [
        ...new Set(
          raw.managedCodes.filter(
            (code): code is string => typeof code === "string" && /^\d{6}$/.test(code)
          )
        )
      ].slice(0, 100)
    : [];
  for (const key of ["lastSyncedAt", "uploadedAt"] as const)
    if (typeof raw[key] === "string" && Number.isFinite(Date.parse(raw[key])))
      result[key] = raw[key];
  return result;
}
/** Remove only missing positions previously managed by this synchronization binding. */
export function applyThsSync(
  settings: UserSettings,
  preview: ThsPreview,
  managedCodes: string[]
): UserSettings {
  const next = mergeThsHoldings(settings, preview, "merge");
  const incoming = new Set(preview.positions.map((item) => item.code));
  const managed = new Set(managedCodes);
  next.holdings = next.holdings.filter(
    (item) => !managed.has(item.securityCode) || incoming.has(item.securityCode)
  );
  // Keep the user's existing row order stable between unchanged polls.
  const order = new Map(settings.holdings.map((item, index) => [item.securityCode, index]));
  next.holdings.sort(
    (a, b) => (order.get(a.securityCode) ?? Infinity) - (order.get(b.securityCode) ?? Infinity)
  );
  return next;
}
export interface ThsSyncPorts {
  fetch: (portfolioId: string) => Promise<ThsPreview>;
  readSettings: () => UserSettings;
  saveSettings: (settings: UserSettings) => Promise<unknown>;
  persist: (state: ThsSyncState) => Promise<void>;
  pauseReason: () => string;
  manualPauseReason?: () => string;
  now?: () => Date;
}
export class ThsSyncRunner {
  private state = defaultThsSyncState();
  private running = false;
  private message = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private stopped = true;
  constructor(private readonly ports: ThsSyncPorts) {}
  restore(value: unknown): void {
    this.state = normalizeThsSyncState(value);
  }
  snapshot(): ThsSyncState {
    return structuredClone(this.state);
  }
  status(): ThsSyncStatus {
    const { managedCodes: _codes, ...status } = this.state;
    return {
      ...status,
      running: this.running,
      message: this.state.enabled ? this.ports.pauseReason() || this.message : "自动同步已关闭"
    };
  }
  async configure(
    enabled: boolean,
    portfolioId: string,
    portfolioName: string,
    intervalSeconds: number
  ): Promise<void> {
    if (![60, 300, 900].includes(intervalSeconds))
      throw new Error("请选择1分钟、5分钟或15分钟同步间隔");
    if (enabled && !portfolioId) throw new Error("请先选择需要自动同步的账本");
    const changed = this.state.portfolioId !== portfolioId;
    const next = {
      ...(changed ? defaultThsSyncState() : this.state),
      enabled,
      portfolioId,
      portfolioName,
      intervalSeconds
    };
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.ports.persist(next);
    } catch (error) {
      this.start();
      throw error;
    }
    this.state = next;
    this.message = "";
    this.start();
  }
  start(): void {
    this.stopped = false;
    this.schedule(0);
  }
  stop(): void {
    this.stopped = true;
    ++this.revision;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  wake(): void {
    if (!this.stopped) this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.state.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().finally(() => {
        if (!this.stopped)
          this.schedule(this.ports.pauseReason() ? 15000 : this.state.intervalSeconds * 1000);
      });
    }, delay);
    this.timer.unref?.();
  }
  async runNow(): Promise<void> {
    if (!this.state.enabled || this.stopped) throw new Error("请先开启自动同步");
    if (this.running) throw new Error("正在同步中，请等待完成");
    if (this.timer) clearTimeout(this.timer);
    try {
      if (!(await this.runOnce(true))) throw new Error(this.message || "同步已取消，请重试");
    } finally {
      this.schedule(this.state.intervalSeconds * 1000);
    }
  }
  async runOnce(manual = false): Promise<boolean> {
    if (this.stopped || !this.state.enabled || this.running) return false;
    const pauseReason = manual
      ? (this.ports.manualPauseReason ?? this.ports.pauseReason)
      : this.ports.pauseReason;
    const pause = pauseReason();
    if (pause) {
      this.message = pause;
      return false;
    }
    const revision = this.revision;
    this.running = true;
    this.message = "正在同步持仓…";
    try {
      const preview = await this.ports.fetch(this.state.portfolioId);
      if (this.stopped || revision !== this.revision || !this.state.enabled) return false;
      if (pauseReason()) {
        this.message = pauseReason();
        return false;
      }
      if (preview.portfolio.id !== this.state.portfolioId)
        throw new Error("返回的账本与同步账本不一致，未更新持仓");
      if (this.state.uploadedAt && !preview.uploadedAt)
        throw new Error("本次账本缺少上传时间，无法核对新旧，已保留本地持仓");
      if (
        this.state.uploadedAt &&
        preview.uploadedAt &&
        Date.parse(preview.uploadedAt) < Date.parse(this.state.uploadedAt)
      )
        throw new Error("账本上传时间早于上次同步，已保留本地持仓");
      const current = this.ports.readSettings();
      const next = applyThsSync(current, preview, this.state.managedCodes);
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.ports.saveSettings(next);
      if (this.stopped || revision !== this.revision) return false;
      this.state = {
        ...this.state,
        managedCodes: preview.positions.map((item) => item.code),
        lastSyncedAt: (this.ports.now?.() ?? new Date()).toISOString(),
        uploadedAt: preview.uploadedAt
      };
      await this.ports.persist(this.state);
      this.message = "持仓已同步；以账本最新上传的数据为准";
      return true;
    } catch (error) {
      if (revision === this.revision)
        this.message = error instanceof Error ? error.message : "自动同步失败，已保留本地持仓";
      return false;
    } finally {
      this.running = false;
    }
  }
}
