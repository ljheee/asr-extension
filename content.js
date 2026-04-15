// content.js — 注入浮窗，处理两种模式
// WS 连接由 background.js 维护，PCM 数据通过消息传递

const DEFAULT_HOTKEY = { alt: false, shift: true, ctrl: true, key: '1' }; // Ctrl+Shift+1

let hotkey = { ...DEFAULT_HOTKEY };
let mode = 'panel';
let audioCtx = null, processor = null, mediaStream = null;
let lastFocusedEl = null;
let lastSavedRange = null; // contentEditable 的光标位置
let lastInsertedText = ''; // 上次插入的临时文字，用于回删替换
let isRecording = false;
let isClosing = false;
let currentTriggerMode = 'panel';

chrome.storage.sync.get(['hotkey'], (res) => {
  if (res.hotkey) hotkey = res.hotkey;
});

// ── 注入 UI ──────────────────────────────────────
function injectPanel() {
  if (document.getElementById('asr-ext-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'asr-ext-panel';
  panel.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:2147483647;
    background:#1a1a1a; border:1px solid #333; border-radius:16px;
    padding:16px; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.6);
    font-family:-apple-system,sans-serif; color:#e0e0e0;
    user-select:none;
  `;
  panel.innerHTML = `
    <div id="asr-drag" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:move">
      <span style="font-size:12px;color:#666">⠿ 豆包 ASR</span>
      <div style="display:flex;gap:10px;align-items:center">
        <span id="asr-mode-toggle" title="切换模式" style="font-size:11px;color:#555;cursor:pointer;padding:2px 6px;border:1px solid #333;border-radius:4px">浮窗</span>
        <a id="asr-options" title="设置" style="font-size:14px;color:#555;cursor:pointer;text-decoration:none">⚙</a>
        <span id="asr-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">×</span>
      </div>
    </div>

    <button id="asr-btn" style="
      width:100%; height:52px; border-radius:12px; border:none;
      background:#2a2a2a; color:#aaa; font-size:14px; cursor:pointer;
      transition:all 0.15s; outline:none; user-select:none;
    ">按住说话</button>

    <div id="asr-result" style="
      margin-top:12px; height:100px; background:#111;
      border-radius:10px; padding:10px 12px;
      font-size:15px; line-height:1.6; color:#f0f0f0;
      word-break:break-all; overflow-y:auto;
    "><span id="asr-current" style="color:#666;font-size:12px">识别结果</span></div>

    <div id="asr-status" style="margin-top:8px;font-size:11px;color:#555;text-align:center">就绪 · 浮窗模式</div>
  `;
  document.body.appendChild(panel);

  const btn = document.getElementById('asr-btn');
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); startASR('panel'); });
  btn.addEventListener('mouseup', stopASR);

  document.getElementById('asr-mode-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleMode(); });
  document.getElementById('asr-options').addEventListener('click', (e) => { e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });
  document.getElementById('asr-close').addEventListener('click', (e) => { e.stopPropagation();
    stopASR();
    panel.remove();
  });

  initDrag();
}

// ── 模式切换 ─────────────────────────────────────
function toggleMode() {
  mode = mode === 'panel' ? 'cursor' : 'panel';
  const toggle = document.getElementById('asr-mode-toggle');
  const btn = document.getElementById('asr-btn');
  if (mode === 'cursor') {
    toggle.textContent = '光标';
    toggle.style.color = '#3a7bd5';
    toggle.style.borderColor = '#3a7bd5';
    btn.style.opacity = '0.4';
    btn.style.pointerEvents = 'none';
    setStatus('光标模式 · 按住 Ctrl+Shift+1 说话', '#3a7bd5');
  } else {
    toggle.textContent = '浮窗';
    toggle.style.color = '#555';
    toggle.style.borderColor = '#333';
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    setStatus('就绪 · 浮窗模式', '#555');
  }
}

// ── 快捷键监听 ────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (mode !== 'cursor' || isRecording) return;
  if (matchHotkey(e)) {
    e.preventDefault();
    lastFocusedEl = document.activeElement;
    if (lastFocusedEl?.isContentEditable) {
      const sel = window.getSelection();
      lastSavedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    } else {
      lastSavedRange = null;
    }
    startASR('cursor');
  }
}, true); // capture 模式，在事件到达目标前拦截

document.addEventListener('keyup', (e) => {
  if (mode !== 'cursor' || !isRecording) return;
  console.log('[ASR keyup]', e.key, e.code, e.ctrlKey, e.shiftKey);
  const triggerKey = hotkey.key || '1';
  if (e.code === 'Digit1' || e.key.toLowerCase() === triggerKey.toLowerCase()) {
    lastFocusedEl = document.activeElement;
    if (lastFocusedEl?.isContentEditable) {
      const sel = window.getSelection();
      lastSavedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    }
    stopASR();
  }
}, true); // capture 模式

function matchHotkey(e) {
  if (hotkey.alt && !e.altKey) return false;
  if (!hotkey.alt && e.altKey) return false;
  if (hotkey.shift && !e.shiftKey) return false;
  if (hotkey.ctrl && !e.ctrlKey) return false;
  const triggerKey = hotkey.key || '1';
  // 用 e.code 匹配物理键位，不受修饰键影响
  const expectedCode = triggerKey >= '0' && triggerKey <= '9'
    ? 'Digit' + triggerKey
    : 'Key' + triggerKey.toUpperCase();
  if (e.code !== expectedCode && e.key.toLowerCase() !== triggerKey.toLowerCase()) return false;
  return true;
}

// ── ASR 核心 ─────────────────────────────────────
async function startASR(triggerMode) {
  if (isRecording || isClosing) return;

  const loggedIn = await new Promise(resolve => checkLogin(resolve));
  if (!loggedIn) return;

  isRecording = true;
  currentTriggerMode = triggerMode;
  lastInsertedText = '';

  const btn = document.getElementById('asr-btn');
  if (btn) { btn.style.background = '#c0392b'; btn.style.color = '#fff'; btn.textContent = '录音中…'; }
  const currentEl = document.getElementById('asr-current');
  if (currentEl) currentEl.textContent = '';
  setStatus('连接中…', '#f39c12');

  // 申请麦克风
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true }
    });
  } catch(e) {
    setStatus('麦克风权限被拒绝', '#e74c3c');
    resetBtn(); isRecording = false; return;
  }

  // 让 background 建立 WS（Cookie 在 background 上下文自动携带）
  chrome.runtime.sendMessage({ type: 'WS_OPEN' });

  // 等 WS_EVENT open 后再启动录音（见 onMessage 处理）
}

// ── 收到 background 的 WS 事件 ───────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WS_EVENT') {
    if (msg.event === 'no_doubao_tab') {
      setStatus('请先打开豆包页面 →', '#e74c3c');
      const statusEl = document.getElementById('asr-status');
      if (statusEl) { statusEl.style.cursor = 'pointer'; statusEl.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DOUBAO' }); }
      isRecording = false; resetBtn(); return;
    }
    if (msg.event === 'open') {
      setStatus(currentTriggerMode === 'cursor' ? '说话中… (松开Alt/Shift停止)' : '说话中…', '#27ae60');
      startMic();
    }
    if (msg.event === 'message') {
      handleASRMessage(msg.data);
    }
    if (msg.event === 'error') {
      setStatus('WS 错误', '#e74c3c'); isRecording = false; isClosing = false; resetBtn();
    }
    if (msg.event === 'close') {
      setStatus(msg.code === 1000
        ? (mode === 'cursor' ? '就绪 · 光标模式' : '就绪 · 浮窗模式')
        : `异常断开 ${msg.code}`,
        msg.code === 1000 ? '#555' : '#e74c3c');
      isRecording = false;
      isClosing = false;
    }
  }

  if (msg.type === 'LOGIN_STATE_CHANGED') {
    const statusEl = document.getElementById('asr-status');
    const btn = document.getElementById('asr-btn');
    if (msg.loggedIn) {
      if (statusEl) { statusEl.style.cursor = ''; statusEl.onclick = null; }
      if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = mode === 'cursor' ? 'none' : 'auto'; }
      setStatus(mode === 'cursor' ? '就绪 · 光标模式' : '就绪 · 浮窗模式', '#27ae60');
      setTimeout(() => setStatus(mode === 'cursor' ? '就绪 · 光标模式' : '就绪 · 浮窗模式', '#555'), 2000);
    } else {
      setStatus('未登录豆包，点此前往登录 →', '#e74c3c');
      if (statusEl) { statusEl.style.cursor = 'pointer'; statusEl.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DOUBAO' }); }
      if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
    }
  }
});

// ── 启动录音 ─────────────────────────────────────
function startMic() {
  audioCtx = new AudioContext({ sampleRate: 16000 });
  const src = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    const f32 = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    // ArrayBuffer 无法直接传消息，转为普通对象
    chrome.runtime.sendMessage({ type: 'WS_SEND', data: Array.from(new Uint8Array(i16.buffer)) });
  };
  src.connect(processor);
  processor.connect(audioCtx.destination);
}

// ── 处理识别结果 ──────────────────────────────────
function handleASRMessage(dataStr) {
  let msg;
  try { msg = JSON.parse(dataStr); } catch(e) { return; }

  if (msg.event === 'result' && msg.result?.Text) {
    const text = msg.result.Text;
    const currentEl = document.getElementById('asr-current');
    if (currentEl) currentEl.textContent = text;
    const resultEl = document.getElementById('asr-result');
    if (resultEl) resultEl.scrollTop = resultEl.scrollHeight;
    // 光标模式：趁编辑器还在焦点，实时替换临时文字
    if (currentTriggerMode === 'cursor' && lastFocusedEl) {
      replaceInserted(lastFocusedEl, lastInsertedText, text, lastSavedRange);
      lastInsertedText = text;
    }
  }

  if (msg.event === 'finish') {
    // 浮窗固化历史
    const currentEl = document.getElementById('asr-current');
    const resultEl = document.getElementById('asr-result');
    if (currentEl && resultEl && currentEl.textContent) {
      const line = document.createElement('div');
      line.textContent = currentEl.textContent;
      line.style.color = '#f0f0f0';
      resultEl.insertBefore(line, currentEl);
      currentEl.textContent = '';
      resultEl.scrollTop = resultEl.scrollHeight;
    }
    // 光标模式：文字已实时插入，重置状态
    lastInsertedText = '';
    setStatus(currentTriggerMode === 'cursor' ? '就绪 · 光标模式' : '识别完成', '#9b59b6');
  }
}

// ── 停止 ─────────────────────────────────────────
function stopASR() {
  if (!isRecording) return;
  isClosing = true;
  if (processor) { processor.disconnect(); processor = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  chrome.runtime.sendMessage({ type: 'WS_CLOSE' });
  resetBtn();
}

function resetBtn() {
  const btn = document.getElementById('asr-btn');
  if (btn) { btn.style.background = '#2a2a2a'; btn.style.color = '#aaa'; btn.textContent = '按住说话'; }
}

// ── 插入文字到光标 ────────────────────────────────
function replaceInserted(el, oldText, newText, savedRange) {
  if (!el) return;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    // 删掉末尾 oldText，插入 newText
    const before = el.value;
    const start = before.endsWith(oldText)
      ? before.length - oldText.length
      : el.selectionStart ?? before.length;
    const end = before.endsWith(oldText) ? before.length : el.selectionEnd ?? before.length;
    el.setSelectionRange(start, end);
    const ok = document.execCommand('insertText', false, newText);
    if (!ok) {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const newVal = before.slice(0, start) + newText + before.slice(end);
      if (setter) setter.call(el, newVal); else el.value = newVal;
      el.selectionStart = el.selectionEnd = start + newText.length;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newText }));
    }
  } else if (el.isContentEditable) {
    const sel = window.getSelection();
    if (sel.rangeCount && oldText.length > 0) {
      // 向左选中上次插入的字符，一次性替换
      for (let i = 0; i < oldText.length; i++) {
        sel.modify('extend', 'backward', 'character');
      }
    }
    document.execCommand('insertText', false, newText);
  }
}

function insertAtCursor(el, text, savedRange) {
  if (!el) return;

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const before = el.value;
    const start = el.selectionStart ?? before.length;
    const end = el.selectionEnd ?? before.length;
    const newValue = before.slice(0, start) + text + before.slice(end);

    el.focus();
    el.setSelectionRange(start, end);
    const ok = document.execCommand('insertText', false, text);

    if (!ok || el.value === before) {
      // React 受控组件降级方案
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, newValue);
      else el.value = newValue;
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

  } else if (el.isContentEditable) {
    document.execCommand('insertText', false, text);
  }
}

// ── 拖拽 ─────────────────────────────────────────
function initDrag() {
  const panelEl = document.getElementById('asr-ext-panel');
  const handle = document.getElementById('asr-drag');
  let dragging = false, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = panelEl.getBoundingClientRect();
    ox = e.clientX - rect.left; oy = e.clientY - rect.top;
    // 先把当前位置固定为 left/top，再清掉 right/bottom
    panelEl.style.left = rect.left + 'px';
    panelEl.style.top = rect.top + 'px';
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panelEl.style.left = (e.clientX - ox) + 'px';
    panelEl.style.top  = (e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

function setStatus(msg, color) {
  const el = document.getElementById('asr-status');
  if (el) { el.textContent = msg; el.style.color = color || '#555'; }
}

// ── 登录检测 ─────────────────────────────────────
function checkLogin(callback) {
  chrome.runtime.sendMessage({ type: 'CHECK_LOGIN' }, (res) => {
    if (chrome.runtime.lastError) { callback && callback(false); return; }
    const loggedIn = res.loggedIn;
    const statusEl = document.getElementById('asr-status');
    const btn = document.getElementById('asr-btn');
    if (!loggedIn) {
      setStatus('未登录豆包，点此前往登录 →', '#e74c3c');
      if (statusEl) { statusEl.style.cursor = 'pointer'; statusEl.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DOUBAO' }); }
      if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
    } else {
      if (statusEl) { statusEl.style.cursor = ''; statusEl.onclick = null; }
      if (btn && mode !== 'cursor') { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
      setStatus(mode === 'cursor' ? '就绪 · 光标模式' : '就绪 · 浮窗模式', '#555');
    }
    callback && callback(loggedIn);
  });
}

// ── 豆包页面：WS 代理 ────────────────────────────
const WS_URL = 'wss://ws-samantha.doubao.com/samantha/audio/asr'
  + '?version_code=20800&language=zh&device_platform=web'
  + '&aid=497858&real_aid=497858&pkg_type=release_version'
  + '&device_id=7616216604401780224&pc_version=3.14.2'
  + '&web_id=7627108056602248710&tea_uuid=7627108056602248710'
  + '&region=&sys_region=&samantha_web=1&use-olympus-account=1'
  + '&format=pcm';

// callerTabId → WebSocket
const proxySessions = {};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROXY_WS_OPEN') {
    const { callerTabId } = msg;
    if (proxySessions[callerTabId]) { proxySessions[callerTabId].close(); delete proxySessions[callerTabId]; }

    const ws = new WebSocket(WS_URL); // 在豆包域下，Cookie 自动携带
    ws.binaryType = 'arraybuffer';
    proxySessions[callerTabId] = ws;

    ws.onopen = () => chrome.runtime.sendMessage({ type: 'PROXY_WS_EVENT', callerTabId, event: 'open' });
    ws.onclose = (e) => {
      chrome.runtime.sendMessage({ type: 'PROXY_WS_EVENT', callerTabId, event: 'close', code: e.code });
      delete proxySessions[callerTabId];
    };
    ws.onerror = () => chrome.runtime.sendMessage({ type: 'PROXY_WS_EVENT', callerTabId, event: 'error' });
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        chrome.runtime.sendMessage({ type: 'PROXY_WS_EVENT', callerTabId, event: 'message', data: e.data });
      }
    };
  }

  if (msg.type === 'PROXY_WS_SEND') {
    const ws = proxySessions[msg.callerTabId];
    if (ws && ws.readyState === WebSocket.OPEN) {
      const arr = new Uint8Array(msg.data);
      ws.send(arr.buffer);
    }
  }

  if (msg.type === 'PROXY_WS_CLOSE') {
    const ws = proxySessions[msg.callerTabId];
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000);
    delete proxySessions[msg.callerTabId];
  }
});

// ── 启动 ─────────────────────────────────────────
injectPanel();
checkLogin();
