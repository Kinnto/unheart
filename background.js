const LIKES_PATH = '/i/history/likes';

chrome.action.onClicked.addListener(async () => {
  const { handle } = await chrome.storage.local.get('handle');
  const targets = [LIKES_PATH, handle && `/${handle.toLowerCase()}/likes`].filter(Boolean);
  const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
  const existing = tabs.find((tab) => {
    if (!tab.url) return false;
    return targets.includes(new URL(tab.url).pathname.toLowerCase().replace(/\/+$/, ''));
  });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `https://x.com${LIKES_PATH}` });
});
