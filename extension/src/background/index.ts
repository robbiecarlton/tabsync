chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`[tabsync] installed (${reason})`);
});
