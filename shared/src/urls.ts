import { matchesExcludeList, type ExcludeRule } from './exclude';
import type { SnapTab, SnapWindow } from './types';

/** URL stored for a New Tab placeholder; reopening it gives the browser's own New Tab page. */
export const NEW_TAB_URL = 'chrome://newtab/';

const NEW_TAB_URLS = new Set([
  'chrome://newtab',
  'brave://newtab',
  'chrome://new-tab-page',
  'chrome-search://local-ntp/local-ntp.html',
  'about:newtab',
]);

const EXCLUDED_SCHEMES = new Set([
  'brave:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'view-source:',
  'file:',
]);

/** Query parameters dropped for matching only (never from stored URLs). */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
]);

function scheme(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
  return match ? match[1]!.toLowerCase() : '';
}

export function isNewTabUrl(url: string): boolean {
  return NEW_TAB_URLS.has(url.toLowerCase().replace(/\/$/, ''));
}

/** True for URLs never captured: browser-internal pages, local files and unparseable URLs. */
export function isExcludedUrl(url: string): boolean {
  const s = scheme(url);
  if (!s) return true;
  if (s === 'about:') return url.toLowerCase() !== 'about:blank';
  return EXCLUDED_SCHEMES.has(s);
}

/**
 * Normalizes a URL for tab matching: drops the #fragment and common tracking parameters
 * (`utm_*`, `fbclid`, `gclid`, …). Other parameters keep their order. Non-HTTP(S) or
 * unparseable URLs are returned unchanged apart from the fragment.
 */
export function normalizeUrlForMatching(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.split('#')[0]!;
  }
  parsed.hash = '';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) parsed.searchParams.delete(key);
    }
    if (parsed.searchParams.size === 0) parsed.search = '';
  }
  return parsed.href;
}

function placeholderTab(): SnapTab {
  return { url: NEW_TAB_URL, title: 'New Tab', pinned: false, active: true };
}

/**
 * Applies the capture rules to one window:
 * - excluded URLs are dropped (internal pages, plus the user's exclude list if given);
 * - New Tab pages are kept as a single placeholder only if nothing else remains;
 * - a window with nothing left (e.g. just settings) yields `null`;
 * - groups with no remaining tabs are dropped;
 * - `data:` favicons are dropped: inline image data barely compresses and could push a large
 *   profile over the server's size limit (PLAN.md D16); favicons are a fallback only.
 */
export interface SanitizeOptions {
  /** The user's exclude list (sites and URL prefixes never synced). */
  exclude?: readonly ExcludeRule[];
}

export function sanitizeWindow(
  window: SnapWindow,
  { exclude = [] }: SanitizeOptions = {},
): SnapWindow | null {
  const hasNewTab = window.tabs.some((t) => isNewTabUrl(t.url));
  let tabs = window.tabs
    .filter(
      (t) => !isNewTabUrl(t.url) && !isExcludedUrl(t.url) && !matchesExcludeList(t.url, exclude),
    )
    .map((t) => {
      if (t.favIconUrl?.startsWith('data:')) {
        const { favIconUrl: _dropped, ...rest } = t;
        return rest;
      }
      return t;
    });
  if (tabs.length === 0) {
    if (!hasNewTab) return null;
    tabs = [placeholderTab()];
  }
  const usedKeys = new Set(tabs.map((t) => t.groupKey).filter((k) => k !== undefined));
  return { ...window, groups: window.groups.filter((g) => usedKeys.has(g.key)), tabs };
}

/** Applies `sanitizeWindow` to every window, dropping those left empty. */
export function sanitizeWindows(
  windows: SnapWindow[],
  options: SanitizeOptions = {},
): SnapWindow[] {
  return windows.map((w) => sanitizeWindow(w, options)).filter((w): w is SnapWindow => w !== null);
}
