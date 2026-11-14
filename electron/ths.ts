import { BrowserWindow, safeStorage, session } from "electron";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "../src/services/atomicFile.js";
import {
  ThsClient,
  normalizeThsCookie,
  mergeThsHoldings,
  type ThsPreview,
  type ThsStatus,
  type ThsPortfolio
} from "../src/services/ths/ledger.js";
import type { UserSettings } from "../src/config.js";
import {
  ThsSyncRunner,
  defaultThsSyncState,
  type ThsSyncPorts,
  type ThsSyncState
} from "../src/services/ths/sync.js";

/** Credentials are encrypted separately from exported application settings. */
export class ThsIntegration {
  private readonly client = new ThsClient();
  private cookie = "";
  private selectedId = "";
  private portfolios: ThsPortfolio[] = [];
  private preview: ThsPreview | null = null;
  private loginWindow: BrowserWindow | null = null;
  private generation = 0;
  private mutation: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();
  private manualSyncing = false;
  readonly sync: ThsSyncRunner;
  constructor(
    private readonly credentialFile: string,
    ports?: Pick<
      ThsSyncPorts,
      "readSettings" | "saveSettings" | "pauseReason" | "manualPauseReason"
    >
  ) {
    this.sync = new ThsSyncRunner({
      fetch: async (id) => {
        const generation = this.generation;
        const result = await this.client.positions(this.cookie, id);
        if (generation !== this.generation) throw new Error("登录状态已改变，下次将重新同步");
        return { ...result, token: "auto-sync" };
      },
      readSettings: () => {
        if (!ports) throw new Error("自动同步尚未初始化");
        return ports.readSettings();
      },
      saveSettings: (settings) => {
        if (!ports) return Promise.reject(new Error("自动同步尚未初始化"));
        return ports.saveSettings(settings);
      },
      persist: (state) => this.persist(this.cookie, this.selectedId, state),
      manualPauseReason: () =>
        !this.cookie
          ? "请重新登录同花顺"
          : this.loginWindow
            ? "请先完成登录"
            : (ports?.manualPauseReason?.() ?? ports?.pauseReason() ?? "自动同步尚未初始化"),
      pauseReason: () =>
        !this.cookie
          ? "请重新登录同花顺"
          : this.loginWindow
            ? "正在登录，自动同步已暂停"
            : (ports?.pauseReason() ?? "自动同步尚未初始化")
    });
  }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.credentialFile, "utf8")) as {
        encrypted: string;
      };
      if (!safeStorage.isEncryptionAvailable()) return;
      const saved = JSON.parse(
        safeStorage.decryptString(Buffer.from(value.encrypted, "base64"))
      ) as { cookie: string; selectedId: string; sync?: unknown };
      this.cookie = normalizeThsCookie(saved.cookie);
      this.selectedId = typeof saved.selectedId === "string" ? saved.selectedId : "";
      this.sync.restore(saved.sync);
    } catch {
      /* Missing or unreadable credentials require a fresh sign-in. */
    }
  }
  status(): ThsStatus {
    return {
      configured: !!this.cookie,
      selectedId: this.selectedId,
      portfolios: structuredClone(this.portfolios),
      sync: this.sync.status()
    };
  }
  private async persist(
    cookie: string,
    selectedId: string,
    sync: ThsSyncState = this.sync.snapshot()
  ): Promise<void> {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，无法保存同花顺登录");
    const encrypted = safeStorage
      .encryptString(JSON.stringify({ cookie, selectedId, sync }))
      .toString("base64");
    const write = this.writeQueue.then(() =>
      atomicWriteText(this.credentialFile, JSON.stringify({ version: 1, encrypted }))
    );
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
  private async authenticate(value: unknown, generation: number): Promise<ThsStatus> {
    const cookie = normalizeThsCookie(value);
    const portfolios = await this.client.list(cookie);
    if (generation !== this.generation) throw new Error("登录操作已取消");
    const selectedId = portfolios.length === 1 ? portfolios[0]!.id : "";
    // A fresh sign-in may belong to a different user: require an explicit new binding.
    this.sync.stop();
    const previousSync = this.sync.snapshot();
    const disabledSync = {
      ...defaultThsSyncState(),
      intervalSeconds: previousSync.intervalSeconds
    };
    await this.persist(cookie, selectedId, disabledSync);
    this.sync.restore(disabledSync);
    this.sync.start();
    this.cookie = cookie;
    this.selectedId = selectedId;
    this.portfolios = portfolios;
    this.preview = null;
    return this.status();
  }
  cancelLogin(): void {
    ++this.generation;
    this.loginWindow?.close();
    this.loginWindow = null;
  }
  async login(): Promise<ThsStatus> {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，无法保存同花顺登录");
    if (this.loginWindow) {
      this.loginWindow.focus();
      throw new Error("请在已打开的窗口完成登录");
    }
    const generation = ++this.generation;
    const loginSession = session.fromPartition(`ths-login-${randomUUID()}`);
    const win = new BrowserWindow({
      width: 1000,
      height: 760,
      title: "同花顺投资账本登录",
      autoHideMenuBar: true,
      webPreferences: {
        session: loginSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false
      }
    });
    this.loginWindow = win;
    const allowed = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return (
          parsed.protocol === "https:" &&
          (parsed.hostname === "10jqka.com.cn" || parsed.hostname.endsWith(".10jqka.com.cn"))
        );
      } catch {
        return false;
      }
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) void win.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    loginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    return new Promise<ThsStatus>((resolve, reject) => {
      let finished = false,
        checking = false;
      const finish = (result?: ThsStatus, error?: Error): void => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        clearTimeout(timeout);
        if (this.loginWindow === win) this.loginWindow = null;
        if (!win.isDestroyed()) win.destroy();
        void loginSession.clearStorageData().catch(() => undefined);
        if (result) resolve(result);
        else reject(error ?? new Error("登录已取消"));
      };
      const timer = setInterval(() => {
        void (async () => {
          if (checking || finished) return;
          checking = true;
          try {
            const cookies = await loginSession.cookies.get({ url: "https://tzzb.10jqka.com.cn" });
            if (!cookies.some((item) => item.name === "userid" && item.value)) return;
            const result = await this.exclusive(() =>
              this.authenticate(
                cookies.map((item) => `${item.name}=${item.value}`).join("; "),
                generation
              )
            );
            if (!finished) finish(result);
          } catch {
            /* Login pages can set userid before their remaining tickets are ready. */
          } finally {
            checking = false;
          }
        })();
      }, 1500);
      const timeout = setTimeout(() => {
        ++this.generation;
        finish(undefined, new Error("等待登录超时，请重新登录或使用手动登录凭据"));
      }, 300000);
      win.on("closed", () => {
        if (!finished) {
          ++this.generation;
          finish();
        }
      });
      void win
        .loadURL("https://tzzb.10jqka.com.cn")
        .catch(() => finish(undefined, new Error("同花顺登录页面无法打开，请检查网络")));
    });
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(operation);
    this.mutation = task.catch(() => undefined);
    return task;
  }
  async request(value: unknown): Promise<ThsStatus | ThsPreview | UserSettings> {
    if (!value || typeof value !== "object") throw new Error("同花顺操作无效");
    const input = value as Record<string, unknown>;
    if (input.action === "status") return this.status();
    if (input.action === "sync-now") {
      if (this.manualSyncing) throw new Error("正在同步中，请等待完成");
      this.manualSyncing = true;
      try {
        const state = this.sync.snapshot();
        if (state.enabled && input.portfolioId !== state.portfolioId)
          throw new Error("请同步当前绑定的账本，切换账本需先关闭自动同步");
        if (!state.enabled)
          await this.request({
            action: "sync-configure",
            enabled: true,
            portfolioId: input.portfolioId,
            intervalSeconds: input.intervalSeconds
          });
        await this.sync.runNow();
        this.preview = null;
        return this.status();
      } finally {
        this.manualSyncing = false;
      }
    }
    if (input.action === "login") return this.login();
    if (input.action === "cancel") {
      this.cancelLogin();
      return this.status();
    }
    if (input.action === "logout") {
      this.cancelLogin();
      this.sync.stop();
      return this.exclusive(async () => {
        await this.writeQueue;
        await rm(this.credentialFile, { force: true });
        this.sync.restore(null);
        this.cookie = "";
        this.selectedId = "";
        this.portfolios = [];
        this.preview = null;
        return this.status();
      });
    }
    if (input.action === "sync-configure")
      return this.exclusive(async () => {
        if (
          typeof input.enabled !== "boolean" ||
          typeof input.portfolioId !== "string" ||
          typeof input.intervalSeconds !== "number"
        )
          throw new Error("自动同步配置无效");
        if (input.enabled) {
          if (this.loginWindow) throw new Error("请先完成登录");
          const generation = this.generation;
          const portfolios = await this.client.list(this.cookie);
          if (generation !== this.generation) throw new Error("登录状态已改变，请重试");
          const portfolio = portfolios.find((item) => item.id === input.portfolioId);
          if (!portfolio) throw new Error("同步账本不存在，请刷新后重新选择");
          this.portfolios = portfolios;
          const previousSelection = this.selectedId;
          this.selectedId = portfolio.id;
          try {
            await this.sync.configure(true, portfolio.id, portfolio.name, input.intervalSeconds);
          } catch (error) {
            this.selectedId = previousSelection;
            throw error;
          }
        } else {
          const state = this.sync.snapshot();
          await this.sync.configure(
            false,
            state.portfolioId,
            state.portfolioName,
            input.intervalSeconds
          );
        }
        return this.status();
      });
    if (input.action === "cookie") {
      if (this.loginWindow) throw new Error("请先取消登录窗口");
      const generation = ++this.generation;
      return this.exclusive(() => this.authenticate(input.cookie, generation));
    }
    if (input.action === "list") {
      const cookie = this.cookie,
        generation = this.generation;
      const portfolios = await this.client.list(cookie);
      if (generation !== this.generation) throw new Error("登录状态已改变，请重试");
      this.portfolios = portfolios;
      if (!portfolios.some((item) => item.id === this.selectedId)) this.selectedId = "";
      this.preview = null;
      return this.status();
    }
    if (input.action === "preview")
      return this.exclusive(async () => {
        this.preview = null;
        if (
          typeof input.portfolioId !== "string" ||
          !input.portfolioId ||
          input.portfolioId.length > 256
        )
          throw new Error("请选择账本");
        const generation = this.generation;
        const data = await this.client.positions(this.cookie, input.portfolioId);
        if (generation !== this.generation) throw new Error("登录状态已改变，请重试");
        await this.persist(this.cookie, input.portfolioId);
        this.selectedId = input.portfolioId;
        this.preview = { ...data, token: randomUUID() };
        return structuredClone(this.preview);
      });
    if (input.action === "import") {
      if (
        !this.preview ||
        input.token !== this.preview.token ||
        Date.now() - Date.parse(this.preview.queriedAt) > 600000
      )
        throw new Error("持仓预览已失效，请重新读取");
      if (input.mode !== "merge" && input.mode !== "replace") throw new Error("导入方式无效");
      const next = mergeThsHoldings(input.settings as UserSettings, this.preview, input.mode);
      this.preview = null;
      return next;
    }
    throw new Error("同花顺操作无效");
  }
}
