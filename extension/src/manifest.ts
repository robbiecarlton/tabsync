export interface ManifestOptions {
  version: string;
}

/** Hosts the extension may call. The Railway URL is added at deploy (milestone 6). */
export const SERVER_HOST_PERMISSIONS = ['http://localhost:8787/*'];

export function buildManifest({ version }: ManifestOptions): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'Tab Sync',
    description: 'End-to-end encrypted tab, pinned tab and tab group sync between machines.',
    version,
    permissions: ['tabs', 'tabGroups', 'storage', 'alarms', 'favicon'],
    host_permissions: SERVER_HOST_PERMISSIONS,
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Set up sync' },
    options_page: 'options.html',
  };
}
