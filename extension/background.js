// Service worker: owns the context menu, runs the fetch chain (lib/pin.js) to hand the image to
// the server, then opens the server's board picker (/pick/<token>) in a popup window. The picker
// is a normal web page, so picker changes ship with the server and never need a reinstall. The
// page reports the outcome by navigating to /pick/<token>/done or /cancelled; we watch the popup's
// URL for that, close it and show the in-page toast on the page the click came from.

import { getConfig, api } from './lib/api.js';
import { createPick } from './lib/pin.js';

const MENU_ID = 'pinnery-pin';
const PICKER_W = 420;
const PICKER_H = 600;
const RESULT_RE = /^\/pick\/([0-9a-f]{32})\/(done|cancelled)$/;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Pin to Pinnery', contexts: ['image'] });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) handleClick(info, tab).catch((e) => console.error('[pinnery]', e));
});

// Ask the content script in the clicked frame for the image it saw under the pointer. Pages that
// were open before the extension was installed have no content script yet: inject it and retry
// (it won't know the clicked element then, but can still fetch and show toasts).
async function resolve(tab, info) {
  const frameId = info.frameId || 0;
  const msg = { type: 'resolve', srcUrl: info.srcUrl };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, { frameId });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, msg, { frameId });
    } catch {
      return null;
    }
  }
}

// Show a toast on the page the click came from; a system notification if there's no content script.
async function toast(tabId, text, ok, url) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toast', text, ok, url }, { frameId: 0 });
  } catch {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Pinnery', message: text }).catch?.(() => {});
  }
}

// The worker's idle timer only resets on extension API calls, so a long fetch or upload could see
// it killed mid-job. A cheap API call every 20s keeps it alive until the job is done.
function keepAlive() {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  return () => clearInterval(timer);
}

async function handleClick(info, tab) {
  const cfg = await getConfig();
  if (!cfg) return chrome.runtime.openOptionsPage();
  const resolved = await resolve(tab, info);
  const candidates = [...new Set([...(resolved?.candidates || []), info.srcUrl].filter(Boolean))];
  const job = {
    tabId: tab.id,
    frameId: info.frameId || 0,
    candidates,
    pageUrl: info.pageUrl || tab.url || '',
    pageTitle: tab.title || resolved?.title || '',
  };

  const release = keepAlive();
  let result;
  try {
    result = await createPick(cfg, job);
  } catch (e) {
    if (e.kind === 'unauthorised') chrome.runtime.openOptionsPage();
    return toast(tab.id, e.message, false);
  } finally {
    release();
  }
  await openPicker(cfg, job, result.token, tab.windowId);
  return result;
}

// One picker at a time, centred over the window the click came from. The popup is remembered in
// storage.session (keyed by its window id) so a restarted worker can still recognise it.
async function openPicker(cfg, job, token, windowId) {
  const { pickerWindowId } = await chrome.storage.session.get('pickerWindowId');
  if (pickerWindowId) await chrome.windows.remove(pickerWindowId).catch(() => {});
  let left, top;
  try {
    const win = await chrome.windows.get(windowId);
    left = Math.max(0, Math.round(win.left + (win.width - PICKER_W) / 2));
    top = Math.max(0, Math.round(win.top + (win.height - PICKER_H) / 2));
  } catch {}
  const popup = await chrome.windows.create({
    url: `${cfg.server}/pick/${token}`,
    type: 'popup',
    width: PICKER_W,
    height: PICKER_H,
    left,
    top,
    focused: true,
  });
  await chrome.storage.session.set({
    pickerWindowId: popup.id,
    [pickKey(popup.id)]: { token, server: cfg.server, tabId: job.tabId, done: false },
  });
}

const pickKey = (windowId) => `pick:${windowId}`;
const getPick = async (windowId) => (await chrome.storage.session.get(pickKey(windowId)))[pickKey(windowId)] || null;

// The picker page reports its outcome in the URL. Only navigations within our server count.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const pick = await getPick(tab.windowId);
  if (!pick || pick.done) return;
  let url;
  try { url = new URL(changeInfo.url); } catch { return; }
  const m = url.origin === pick.server && url.pathname.match(RESULT_RE);
  if (!m || m[1] !== pick.token) return;
  await chrome.storage.session.set({ [pickKey(tab.windowId)]: { ...pick, done: true } });
  if (m[2] === 'done') {
    const boardId = Number(url.searchParams.get('board'));
    const name = url.searchParams.get('name') || 'board';
    toast(pick.tabId, `Pinned to “${name}”`, true, boardId ? `${pick.server}/b/${boardId}` : null);
  }
  chrome.windows.remove(tab.windowId).catch(() => {});
});

// Popup closed. If it never reported an outcome (the window's close button, Alt-F4, or we replaced
// it with a newer picker), the parked image is discarded so it isn't left waiting on the server.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const pick = await getPick(windowId);
  if (!pick) return;
  await chrome.storage.session.remove(pickKey(windowId));
  const { pickerWindowId } = await chrome.storage.session.get('pickerWindowId');
  if (pickerWindowId === windowId) await chrome.storage.session.remove('pickerWindowId');
  if (!pick.done) api.discardPick(pick.server, pick.token).catch(() => {});
});

// The in-page toast asks us to open the board it pinned to: a focused tab right after the page's
// own tab (not at the end of the strip), owned by that tab so closing it returns there.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'open' || !sender.tab || !/^https?:/i.test(msg.url || '')) return;
  chrome.tabs.create({
    url: msg.url,
    windowId: sender.tab.windowId,
    index: sender.tab.index + 1,
    openerTabId: sender.tab.id,
    active: true,
  }).catch((e) => console.error('[pinnery]', e));
});

// Exposed so the flow can be driven without a real right-click (tests).
self.handleClick = handleClick;
