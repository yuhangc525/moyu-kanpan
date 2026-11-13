import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSavableSettings, loadAppConfigFromObject, toUserSettings } from "../config.js";
import { exportProfile, previewProfileImport } from "../settings/profile.js";
import { SettingsStore } from "../settings/store.js";
import {
  HOLDINGS_WATCHLIST_GROUP_ID,
  watchlistViewGroups,
  normalizeWatchlistGroups,
  removeWatchlistGroup,
  visibleWatchlistCodes
} from "./watchlistGroups.js";

function settings() {
  return toUserSettings(loadAppConfigFromObject({ watchlist: ["000001", "600519"] }, {}));
}

it("migrates existing stocks and unknown group references to the default group", () => {
  const config = loadAppConfigFromObject(
    { schemaVersion: 9, watchlist: ["000001", { securityCode: "600519", groupId: "legacy" }] },
    {}
  );
  assert.deepEqual(config.watchlistGroups, [{ id: "all", name: "默认分组" }]);
  assert.deepEqual(
    config.watchlist.map((item) => item.groupId),
    ["all", "all"]
  );
  assert.equal(config.schemaVersion, 10);
});

it("filters groups without losing manual order or exposing hidden stocks", () => {
  const value = settings();
  value.watchlistGroups.push({ id: "tech", name: "科技" });
  value.watchlist[0]!.groupId = "tech";
  assert.deepEqual(visibleWatchlistCodes(value, "tech"), ["000001"]);
  assert.deepEqual(visibleWatchlistCodes(value, "all"), ["600519"]);
  assert.deepEqual(visibleWatchlistCodes(value), ["000001", "600519"]);
  value.watchlist[0]!.visible = false;
  assert.deepEqual(visibleWatchlistCodes(value, "tech"), []);
});

it("deletes a group by moving its stocks back and protects the default group", () => {
  const value = settings();
  value.watchlistGroups.push({ id: "tech", name: "科技" });
  value.watchlist[0]!.groupId = "tech";
  removeWatchlistGroup(value, "tech");
  removeWatchlistGroup(value, "all");
  assert.equal(value.watchlist.length, 2);
  assert.equal(value.watchlist[0]!.groupId, "all");
  assert.deepEqual(value.watchlistGroups, [{ id: "all", name: "默认分组" }]);
});

it("rejects duplicate names, missing defaults and dangling group references when saving", () => {
  const value = settings();
  value.watchlistGroups.push({ id: "tech", name: "默认分组" });
  assert.throws(() => assertSavableSettings(value), /名称/);
  value.watchlistGroups = [{ id: "tech", name: "科技" }];
  assert.throws(() => assertSavableSettings(value), /默认/);
  value.watchlistGroups = [{ id: "all", name: "默认分组" }];
  value.watchlist[0]!.groupId = "missing";
  assert.throws(() => assertSavableSettings(value), /分组不存在/);
});

it("normalizes invalid and excessive group entries", () => {
  assert.deepEqual(normalizeWatchlistGroups([null, {}, { id: "bad id", name: "错误" }]), [
    { id: "all", name: "默认分组" }
  ]);
  assert.equal(
    normalizeWatchlistGroups(
      Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `组${i}` }))
    ).length,
    20
  );
});

it("exports and imports groups independently from risk groups", () => {
  const value = settings();
  value.watchlistGroups.push({ id: "tech", name: "科技" });
  value.watchlist[0]!.groupId = "tech";
  const preview = previewProfileImport(settings(), exportProfile(value), "replace");
  assert.equal(preview.valid, true, JSON.stringify(preview.issues));
  assert.deepEqual(preview.nextSettings?.watchlistGroups, value.watchlistGroups);
  assert.equal(preview.nextSettings?.watchlist[0]?.groupId, "tech");
  assert.equal(preview.diff.watchlistGroupsChanged, true);
  assert.deepEqual(preview.nextSettings?.risk.groups, []);
});

it("detects a group-only profile change and preserves groups for older profile packages", () => {
  const value = settings();
  const preview = previewProfileImport(
    value,
    JSON.stringify({ profileVersion: 1, watchlistGroups: [{ id: "all", name: "观察池" }] }),
    "merge"
  );
  assert.equal(preview.valid, true);
  assert.equal(preview.hasChanges, true);
  value.watchlistGroups.push({ id: "tech", name: "科技" });
  const legacy = previewProfileImport(
    value,
    JSON.stringify({ profileVersion: 1, watchlist: ["000001"] }),
    "replace"
  );
  assert.equal(legacy.valid, true);
  assert.deepEqual(legacy.nextSettings?.watchlistGroups, value.watchlistGroups);
});

it("persists the migration and group membership across reloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "watch-groups-"));
  try {
    const file = path.join(directory, "settings.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 9, watchlist: ["000001", "600519"] }));
    const store = new SettingsStore(file, {}, {});
    const migrated = await store.load();
    const persisted = JSON.parse(await readFile(file, "utf8")) as { watchlistGroups: unknown };
    assert.deepEqual(persisted.watchlistGroups, migrated.watchlistGroups);
    const value = toUserSettings(migrated);
    value.watchlistGroups.push({ id: "tech", name: "科技" });
    value.watchlist[0]!.groupId = "tech";
    await store.save(value);
    const loaded = await new SettingsStore(file, {}, {}).load();
    assert.deepEqual(loaded.watchlistGroups, value.watchlistGroups);
    assert.equal(loaded.watchlist[0]!.groupId, "tech");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the holdings group in sync without copying or moving manual watchlist memberships", () => {
  const value = settings();
  const original = structuredClone(value.watchlist);
  const holding = {
    securityCode: "300750",
    quantity: 100,
    costPrice: 10,
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
  assert.deepEqual(visibleWatchlistCodes(value, HOLDINGS_WATCHLIST_GROUP_ID), []);
  value.holdings.push(holding);
  assert.deepEqual(visibleWatchlistCodes(value, HOLDINGS_WATCHLIST_GROUP_ID), ["300750"]);
  assert.deepEqual(visibleWatchlistCodes(value), ["000001", "600519", "300750"]);
  value.holdings.push({ ...holding, securityCode: "000001" });
  assert.deepEqual(visibleWatchlistCodes(value), ["000001", "600519", "300750"]);
  value.holdings = [];
  assert.deepEqual(visibleWatchlistCodes(value, HOLDINGS_WATCHLIST_GROUP_ID), []);
  assert.deepEqual(value.watchlist, original);
  assert.deepEqual(visibleWatchlistCodes(value), ["000001", "600519"]);
});

it("offers a virtual holdings view even with no holdings and never persists its ID", () => {
  const value = settings();
  assert.deepEqual(
    watchlistViewGroups(value).map((group) => group.name),
    ["全部", "持仓", "默认分组"]
  );
  assert.deepEqual(normalizeWatchlistGroups([{ id: HOLDINGS_WATCHLIST_GROUP_ID, name: "持仓" }]), [
    { id: "all", name: "默认分组" }
  ]);
});
