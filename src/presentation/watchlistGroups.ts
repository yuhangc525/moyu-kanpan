import type { UserSettings } from "../config.js";
import { visibleWatchlistCodes, watchlistViewGroups } from "../domain/watchlistGroups.js";
import { escapeAttr, escapeHtml } from "./format.js";

export function renderWatchlistGroups(settings: UserSettings, selectedId: string): string {
  return `<nav class="watchlist-groups" aria-label="自选分组">${watchlistViewGroups(settings)
    .map((group) => {
      const count = visibleWatchlistCodes(settings, group.id).length;
      return `<button type="button" class="watchlist-group${selectedId === group.id ? " active" : ""}" data-action="watchlist-group" data-group-id="${escapeAttr(group.id)}" aria-pressed="${selectedId === group.id}"><span>${escapeHtml(group.name)}</span><small>${count}</small></button>`;
    })
    .join("")}</nav>`;
}
