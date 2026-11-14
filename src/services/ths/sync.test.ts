import assert from "node:assert/strict";
import { it } from "node:test";
import { loadAppConfigFromObject, toUserSettings, type UserSettings } from "../../config.js";
import { applyThsSync, ThsSyncRunner, normalizeThsSyncState, defaultThsSyncState } from "./sync.js";
import type { ThsPreview } from "./ledger.js";
function settings(): UserSettings {
  return toUserSettings(
    loadAppConfigFromObject(
      {
        securities: [
          { code: "000001", market: "SZ", name: "平安银行" },
          { code: "600519", market: "SH", name: "茅台" }
        ],
        holdings: [
          {
            securityCode: "000001",
            quantity: 100,
            costPrice: 10,
            note: "保留备注",
            alertRules: { enabled: true, stopLossPrice: 9 }
          },
          { securityCode: "600519", quantity: 100, costPrice: 1000 }
        ]
      },
      {}
    )
  );
}
function preview(): ThsPreview {
  return {
    token: "sync",
    portfolio: { id: "one", name: "长期账本", broker: "" },
    queriedAt: "2026-11-13T08:00:00Z",
    uploadedAt: "2026-11-13T07:00:00Z",
    positions: [{ code: "000001", market: "SZ", name: "平安银行", quantity: 200, costPrice: 10.5 }]
  };
}
function harness() {
  let current = settings(),
    result = preview(),
    pause = "",
    saves = 0,
    persists = 0;
  let fetcher = () => Promise.resolve(result);
  const runner = new ThsSyncRunner({
    fetch: () => fetcher(),
    readSettings: () => current,
    saveSettings: (next) => {
      current = next;
      saves++;
      return Promise.resolve();
    },
    persist: () => {
      persists++;
      return Promise.resolve();
    },
    pauseReason: () => pause,
    now: () => new Date("2026-11-13T08:01:00Z")
  });
  runner.restore({
    ...defaultThsSyncState(),
    enabled: true,
    portfolioId: "one",
    portfolioName: "长期账本"
  });
  runner.start();
  return {
    runner,
    get current() {
      return current;
    },
    get saves() {
      return saves;
    },
    get persists() {
      return persists;
    },
    set result(next: ThsPreview) {
      result = next;
    },
    set pause(next: string) {
      pause = next;
    },
    set fetcher(next: () => Promise<ThsPreview>) {
      fetcher = next;
    }
  };
}
it("updates synchronized positions, preserves reminder rules and removes only previously synchronized sold positions", () => {
  const before = settings(),
    first = applyThsSync(before, preview(), []);
  assert.equal(first.holdings[0]!.quantity, 200);
  assert.equal(first.holdings[0]!.note, "保留备注");
  assert.deepEqual(first.holdings[0]!.alertRules, before.holdings[0]!.alertRules);
  const empty = applyThsSync(first, { ...preview(), positions: [] }, ["000001"]);
  assert.deepEqual(
    empty.holdings.map((item) => item.securityCode),
    ["600519"]
  );
  assert.deepEqual(empty.watchlist, before.watchlist);
  assert.equal(before.holdings[0]!.quantity, 100);
});
it("persists tracking after success, skips unchanged writes and handles explicit empty holdings", async () => {
  const h = harness();
  try {
    await h.runner.runOnce();
    assert.equal(h.saves, 1);
    assert.deepEqual(h.runner.snapshot().managedCodes, ["000001"]);
    assert.equal(h.runner.status().lastSyncedAt, "2026-11-13T08:01:00.000Z");
    await h.runner.runOnce();
    assert.equal(h.saves, 1);
    h.result = { ...preview(), positions: [] };
    await h.runner.runOnce();
    assert.deepEqual(
      h.current.holdings.map((item) => item.securityCode),
      ["600519"]
    );
    assert.deepEqual(h.runner.snapshot().managedCodes, []);
  } finally {
    h.runner.stop();
  }
});
it("pauses while settings are being edited and preserves holdings on request failures", async () => {
  const h = harness();
  try {
    h.pause = "正在编辑设置";
    await h.runner.runOnce();
    assert.equal(h.saves, 0);
    assert.match(h.runner.status().message, /编辑/);
    h.pause = "";
    h.fetcher = () => Promise.reject(new Error("登录已过期"));
    await h.runner.runOnce();
    assert.equal(h.saves, 0);
    assert.equal(h.persists, 0);
    assert.match(h.runner.status().message, /过期/);
    assert.equal(h.runner.status().lastSyncedAt, null);
  } finally {
    h.runner.stop();
  }
});
it("never overlaps requests or applies a response after automatic sync is disabled", async () => {
  const h = harness();
  let resolve!: (value: ThsPreview) => void;
  let calls = 0;
  try {
    h.fetcher = () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    };
    const pending = h.runner.runOnce();
    await h.runner.runOnce();
    assert.equal(calls, 1);
    await h.runner.configure(false, "one", "长期账本", 60);
    resolve(preview());
    await pending;
    assert.equal(h.saves, 0);
    assert.equal(h.runner.status().enabled, false);
  } finally {
    h.runner.stop();
  }
});
it("checks pause again after network response and uses the latest local reminder rules", async () => {
  const h = harness();
  let resolve!: (value: ThsPreview) => void;
  try {
    h.fetcher = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = h.runner.runOnce();
    h.pause = "设置已打开";
    resolve(preview());
    await pending;
    assert.equal(h.saves, 0);
    h.pause = "";
    h.current.holdings[0]!.note = "同步期间修改的备注";
    h.fetcher = () => Promise.resolve(preview());
    await h.runner.runOnce();
    assert.equal(h.current.holdings[0]!.note, "同步期间修改的备注");
  } finally {
    h.runner.stop();
  }
});
it("rejects mismatched ledgers and older uploads without replacing last successful holdings", async () => {
  const h = harness();
  try {
    await h.runner.runOnce();
    const before = structuredClone(h.current);
    h.result = { ...preview(), uploadedAt: "2026-11-12T07:00:00Z", positions: [] };
    await h.runner.runOnce();
    assert.deepEqual(h.current, before);
    assert.match(h.runner.status().message, /早于/);
    h.result = { ...preview(), portfolio: { ...preview().portfolio, id: "other" } };
    await h.runner.runOnce();
    assert.deepEqual(h.current, before);
    assert.match(h.runner.status().message, /不一致/);
  } finally {
    h.runner.stop();
  }
});
it("restores bounded settings, validates frequency and resets ownership when switching ledgers", async () => {
  const restored = normalizeThsSyncState({
    ...defaultThsSyncState(),
    enabled: true,
    portfolioId: "one",
    managedCodes: ["000001", "000001", "invalid"],
    intervalSeconds: 1
  });
  assert.equal(restored.intervalSeconds, 60);
  assert.deepEqual(restored.managedCodes, ["000001"]);
  assert.equal(normalizeThsSyncState({ enabled: true }).enabled, false);
  const h = harness();
  try {
    await h.runner.runOnce();
    await assert.rejects(h.runner.configure(true, "one", "长期账本", 5));
    await h.runner.configure(true, "two", "短线账本", 300);
    assert.deepEqual(h.runner.snapshot().managedCodes, []);
    assert.equal(h.runner.status().uploadedAt, null);
  } finally {
    h.runner.stop();
  }
});

it("allows explicit immediate sync while settings pause the background loop and keeps auto sync enabled", async () => {
  let current = settings();
  const runner = new ThsSyncRunner({
    fetch: () => Promise.resolve(preview()),
    readSettings: () => current,
    saveSettings: (next) => {
      current = next;
      return Promise.resolve();
    },
    persist: () => Promise.resolve(),
    pauseReason: () => "设置窗口打开",
    manualPauseReason: () => ""
  });
  runner.restore({ ...defaultThsSyncState(), enabled: true, portfolioId: "one" });
  runner.start();
  try {
    await runner.runOnce();
    assert.equal(current.holdings[0]!.quantity, 100);
    await runner.runNow();
    assert.equal(current.holdings[0]!.quantity, 200);
    assert.equal(runner.status().enabled, true);
    assert.ok(runner.status().lastSyncedAt);
    await runner.runOnce();
    assert.equal(runner.status().enabled, true);
  } finally {
    runner.stop();
  }
});
it("reports immediate sync failures without turning off automatic sync or overwriting holdings", async () => {
  const h = harness();
  try {
    h.fetcher = () => Promise.reject(new Error("查询失败"));
    await assert.rejects(h.runner.runNow(), /查询失败/);
    assert.equal(h.runner.status().enabled, true);
    assert.equal(h.saves, 0);
    h.fetcher = () => Promise.resolve(preview());
    await h.runner.runNow();
    assert.equal(h.current.holdings[0]!.quantity, 200);
  } finally {
    h.runner.stop();
  }
});
it("rejects repeated immediate sync requests and honors other write locks", async () => {
  const h = harness();
  let resolve!: (result: ThsPreview) => void;
  try {
    h.fetcher = () =>
      new Promise((done) => {
        resolve = done;
      });
    const first = h.runner.runNow();
    await assert.rejects(h.runner.runNow(), /等待/);
    resolve(preview());
    await first;
    h.pause = "正在保存设置";
    await assert.rejects(h.runner.runNow(), /保存/);
  } finally {
    h.runner.stop();
  }
});
it("continues the timed background loop after a successful immediate sync", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  try {
    await h.runner.runNow();
    assert.equal(h.saves, 1);
    h.result = { ...preview(), positions: [{ ...preview().positions[0]!, quantity: 400 }] };
    context.mock.timers.tick(60000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.current.holdings[0]!.quantity, 400);
    assert.equal(h.saves, 2);
    assert.equal(h.runner.status().enabled, true);
  } finally {
    h.runner.stop();
  }
});
