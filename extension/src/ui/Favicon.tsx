import { useState } from 'preact/hooks';
import { fallbackFavicon, faviconUrl, isDefaultIcon } from './favicons';

/**
 * A page's favicon: the browser's cached icon, or the stored favicon URL when the browser only
 * has its generic default (or fails). Renders an empty box when neither is available.
 * Give it `key={pageUrl}` in lists so state resets when the page changes.
 */
export function Favicon({
  pageUrl,
  stored,
  size = 16,
}: {
  pageUrl: string;
  stored?: string;
  size?: number;
}) {
  const fallback = fallbackFavicon(stored);
  // Fetch at 2x so icons stay sharp on high-density displays.
  const [src, setSrc] = useState<string | undefined>(() => faviconUrl(pageUrl, size * 2));
  const usingCache = src !== undefined && src !== fallback;

  return src ? (
    <img
      class="favicon"
      src={src}
      width={size}
      height={size}
      alt=""
      onLoad={async (e) => {
        if (usingCache && fallback && (await isDefaultIcon(e.currentTarget, size * 2)))
          setSrc(fallback);
      }}
      onError={() => setSrc(usingCache ? fallback : undefined)}
    />
  ) : (
    <span class="favicon" style={{ width: `${size}px`, height: `${size}px` }} />
  );
}
