/**
 * User exclude list (SPEC.md v2): sites and URL prefixes that are never synced.
 *
 * One pattern per line; blank lines and `#` comments are ignored.
 * - `example.com` (or `*.example.com`): that host and all its subdomains, optionally with a port.
 * - `https://example.com/private/`: any URL starting with this (scheme and host case-insensitive).
 */

export type ExcludeRule =
  { kind: 'domain'; host: string; port?: string } | { kind: 'prefix'; prefix: string };

export interface ExcludeListError {
  /** 1-based line number. */
  line: number;
  text: string;
  message: string;
}

export interface ParsedExcludeList {
  rules: ExcludeRule[];
  errors: ExcludeListError[];
}

const HOST_RE = /^(?:\*\.|\.)?((?:[a-z0-9-]+\.)*[a-z0-9-]+)(?::(\d{1,5}))?$/;
/** URL prefixes need "scheme://", so "localhost:3000" is read as a host and port. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parseExcludeList(text: string): ParsedExcludeList {
  const rules: ExcludeRule[] = [];
  const errors: ExcludeListError[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    if (SCHEME_RE.test(line)) {
      try {
        rules.push({ kind: 'prefix', prefix: new URL(line).href });
      } catch {
        errors.push({ line: i + 1, text: raw.trim(), message: 'Not a valid URL' });
      }
      return;
    }
    const m = HOST_RE.exec(line.toLowerCase());
    if (!m) {
      errors.push({
        line: i + 1,
        text: raw.trim(),
        message: 'Use a site like example.com, or a URL starting with https://',
      });
      return;
    }
    rules.push(
      m[2] ? { kind: 'domain', host: m[1]!, port: m[2] } : { kind: 'domain', host: m[1]! },
    );
  });
  return { rules, errors };
}

/** Whether a URL matches any rule. Unparseable URLs never match. */
export function matchesExcludeList(url: string, rules: readonly ExcludeRule[]): boolean {
  if (rules.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return rules.some((r) => {
    if (r.kind === 'prefix') return parsed.href.startsWith(r.prefix);
    if (!host || (host !== r.host && !host.endsWith(`.${r.host}`))) return false;
    return r.port === undefined || parsed.port === r.port;
  });
}
