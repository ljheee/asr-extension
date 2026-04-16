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

// 点击扩展图标，切换当前 tab 的浮窗显示/隐藏
chrome.action.onClicked.addListener((tab) => {
  // 确保豆包 tab 存在且 content script 已注入
  ensureDoubaoTab().then(() => {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  });
});

async function ensureDoubaoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://www.doubao.com/*' }, (tabs) => {
      if (tabs.length > 0) {
        // 已有豆包 tab，检查 content script 是否已注入
        chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            // content script 未注入，刷新后等待加载完成
            waitForTabLoad(tabs[0].id, resolve);
            chrome.tabs.reload(tabs[0].id);
          } else {
            resolve(); // 已注入，直接用
          }
        });
      } else {
        // 没有豆包 tab，后台静默创建
        chrome.tabs.create({ url: 'https://www.doubao.com', active: false }, (newTab) => {
          waitForTabLoad(newTab.id, resolve);
        });
      }
    });
  });
}

function waitForTabLoad(tabId, callback) {
  const listener = (id, info) => {
    if (id === tabId && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(callback, 500); // 等 content script 执行完
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
}

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
