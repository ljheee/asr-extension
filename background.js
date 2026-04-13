// background.js — 消息路由，不直接建 WS

// 找到一个豆包 tab 作为 WS 代理
async function getDoubaoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://www.doubao.com/*' }, (tabs) => {
      resolve(tabs.length > 0 ? tabs[0] : null);
    });
  });
}

// callerTabId → doubaoTabId 映射
const proxyMap = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const callerTabId = sender.tab?.id;

  if (msg.type === 'CHECK_LOGIN') {
    chrome.cookies.getAll({ domain: 'doubao.com' }, (cookies) => {
      sendResponse({ loggedIn: cookies.some(c => c.name === 'sessionid_ss') });
    });
    return true;
  }

  // 非豆包页面请求开启 WS，找豆包 tab 代理
  if (msg.type === 'WS_OPEN') {
    getDoubaoTab().then((doubaoTab) => {
      if (!doubaoTab) {
        // 没有豆包 tab，通知调用方
        chrome.tabs.sendMessage(callerTabId, { type: 'WS_EVENT', event: 'no_doubao_tab' });
        return;
      }
      proxyMap[callerTabId] = doubaoTab.id;
      chrome.tabs.sendMessage(doubaoTab.id, {
        type: 'PROXY_WS_OPEN',
        callerTabId
      });
    });
    return false;
  }

  // 转发 PCM 给豆包 tab
  if (msg.type === 'WS_SEND') {
    const doubaoTabId = proxyMap[callerTabId];
    if (doubaoTabId) {
      chrome.tabs.sendMessage(doubaoTabId, {
        type: 'PROXY_WS_SEND',
        callerTabId,
        data: msg.data
      });
    }
    return false;
  }

  // 关闭 WS
  if (msg.type === 'WS_CLOSE') {
    const doubaoTabId = proxyMap[callerTabId];
    if (doubaoTabId) {
      chrome.tabs.sendMessage(doubaoTabId, { type: 'PROXY_WS_CLOSE', callerTabId });
      delete proxyMap[callerTabId];
    }
    return false;
  }

  // 豆包 tab 回传 WS 事件给原始 tab
  if (msg.type === 'PROXY_WS_EVENT') {
    chrome.tabs.sendMessage(msg.callerTabId, { type: 'WS_EVENT', event: msg.event, data: msg.data, code: msg.code });
    return false;
  }

  if (msg.type === 'OPEN_OPTIONS') { chrome.runtime.openOptionsPage(); }
  if (msg.type === 'OPEN_DOUBAO') { chrome.tabs.create({ url: 'https://www.doubao.com' }); }
});

// 监听豆包 Cookie 变化，通知所有 tab
chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo.cookie;
  if (c.domain.includes('doubao.com') && c.name === 'sessionid_ss') {
    const loggedIn = !changeInfo.removed;
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'LOGIN_STATE_CHANGED', loggedIn })
          .catch(() => {});
      });
    });
  }
});
