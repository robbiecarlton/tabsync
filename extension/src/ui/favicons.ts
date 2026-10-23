/** Favicons from the browser's own cache via the `_favicon` API, with a stored URL as fallback. */

/** `chrome-extension://<id>/_favicon/?pageUrl=…&size=…` (needs the "favicon" permission). */
export function faviconUrl(
  pageUrl: string,
  size: number,
  base = chrome.runtime.getURL('/_favicon/'),
): string {
  return `${base}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

/** A stored favicon URL usable as a fallback: http(s) only. */
export function fallbackFavicon(stored: string | undefined): string | undefined {
  return stored && /^https?:\/\//i.test(stored) ? stored : undefined;
}

export function samePixels(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A URL no browser has a favicon for, so `_favicon` returns its generic default icon. */
const SENTINEL_PAGE = 'https://tabsync.invalid/';
const defaults = new Map<number, Promise<Uint8ClampedArray | undefined>>();

function pixels(img: HTMLImageElement, size: number): Uint8ClampedArray | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

function defaultIconPixels(size: number): Promise<Uint8ClampedArray | undefined> {
  let p = defaults.get(size);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(pixels(img, size));
      img.onerror = () => resolve(undefined);
      img.src = faviconUrl(SENTINEL_PAGE, size);
    });
    defaults.set(size, p);
  }
  return p;
}

/**
 * Whether a loaded `_favicon` image is the browser's generic default icon, i.e. the browser has
 * no favicon cached for that page (typically a tab synced from another machine).
 */
export async function isDefaultIcon(img: HTMLImageElement, size: number): Promise<boolean> {
  const generic = await defaultIconPixels(size);
  const mine = pixels(img, size);
  return !!generic && !!mine && samePixels(generic, mine);
}
