/// <reference types="chrome" />

const PAGE = 'exporter.html';

/** Opens (or focuses) the exporter page; if the user was on a Quip page, offers it as the export scope. */
chrome.action.onClicked.addListener(async (tab) => {
  const page = chrome.runtime.getURL(PAGE);
  const from = tab.url && /^https:\/\/([a-z0-9-]+\.)?quip\.com\//i.test(tab.url) ? tab.url : undefined;
  const existing = await chrome.tabs.query({ url: `${page}*` });
  const open = existing[0];
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    if (from) await chrome.runtime.sendMessage({ type: 'quip-source-url', url: from }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: from ? `${page}?from=${encodeURIComponent(from)}` : page });
});
