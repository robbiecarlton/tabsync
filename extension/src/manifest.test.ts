import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest';

describe('buildManifest', () => {
  const manifest = buildManifest({ version: '1.2.3' });

  it('is MV3 with the given version', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe('1.2.3');
  });

  it('requests only the spec permissions and no broad host access', () => {
    expect(manifest.permissions).toEqual(['tabs', 'tabGroups', 'storage', 'alarms', 'favicon']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    // Broad patterns are optional only: granted per origin when a custom server URL is saved.
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('points at the built entry files', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.options_page).toBe('options.html');
  });
});
