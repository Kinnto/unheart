import { SITE_URL, WEB3FORMS_KEY } from './content/config.js';
import { buildFeedbackPayload } from './content/feedbackPayload.js';

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

if (WEB3FORMS_KEY) chrome.runtime.setUninstallURL(`${SITE_URL}uninstall.html`);

async function sendFeedback({ choice, message }) {
  const payload = buildFeedbackPayload({ key: WEB3FORMS_KEY, choice, message, version: chrome.runtime.getManifest().version });
  if (!payload) return false;
  try {
    const response = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'feedback') return false;
  sendFeedback(msg).then((ok) => sendResponse({ ok }));
  return true;
});
