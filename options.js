const DEFAULT = { ctrl: true, alt: false, shift: true, key: '1' };

chrome.storage.sync.get(['hotkey'], (res) => {
  const hk = res.hotkey || DEFAULT;
  document.getElementById('mod-ctrl').checked = !!hk.ctrl;
  document.getElementById('mod-alt').checked = !!hk.alt;
  document.getElementById('mod-shift').checked = !!hk.shift;
  document.getElementById('extra-key').value = hk.key || '';
});

document.getElementById('save').addEventListener('click', () => {
  const hk = {
    ctrl:  document.getElementById('mod-ctrl').checked,
    alt:   document.getElementById('mod-alt').checked,
    shift: document.getElementById('mod-shift').checked,
    key:   document.getElementById('extra-key').value.trim().toLowerCase(),
  };
  chrome.storage.sync.set({ hotkey: hk }, () => {
    const saved = document.getElementById('saved');
    saved.style.opacity = '1';
    setTimeout(() => saved.style.opacity = '0', 2000);
  });
});
