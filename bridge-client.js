const KtdBridge = (() => {
  let iframe = null;
  let ready = false;
  let readyPromise = null;
  let readyResolve = null;
  let seq = 0;
  const pending = new Map();

  function backendUrl() {
    const raw = String(window.KTD_CONFIG?.GAS_WEB_APP_URL || '').trim();
    if (!raw || raw.includes('PASTE_GAS_WEB_APP')) {
      throw new Error('GAS_WEB_APP_URL belum diisi di config.js.');
    }
    return raw;
  }

  function makeReadyPromise() {
    readyPromise = new Promise(resolve => readyResolve = resolve);
  }

  function mount() {
    if (iframe) iframe.remove();
    ready = false;
    makeReadyPromise();

    iframe = document.createElement('iframe');
    iframe.id = 'ktdBackendBridge';
    iframe.title = 'KTD Backend Bridge';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-9999px;top:-9999px;';
    iframe.src = backendUrl() + (backendUrl().includes('?') ? '&' : '?') + 'bridge=1&t=' + Date.now();
    document.body.appendChild(iframe);
  }

  function init() {
    if (!readyPromise) {
      try { mount(); }
      catch (e) { return Promise.reject(e); }
    }
    return readyPromise;
  }

  function reload() {
    if (!navigator.onLine) return;
    try { mount(); } catch(e) {}
  }

  window.addEventListener('message', event => {
    if (!iframe || event.source !== iframe.contentWindow) return;
    const msg = event.data || {};
    if (!msg.ktdBridge) return;

    if (msg.type === 'ready') {
      ready = true;
      if (readyResolve) readyResolve(true);
      return;
    }

    if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
      const job = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error || 'Backend error'));
    }
  });

  async function call(name, payload) {
    if (!navigator.onLine) throw new Error('Perangkat sedang offline.');

    await init();

    if (!ready) {
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Backend Apps Script belum siap.')), 12000))
      ]);
    }

    const id = 'req-' + Date.now() + '-' + (++seq);
    const timeout = Number(window.KTD_CONFIG?.REQUEST_TIMEOUT_MS || 30000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timeout menghubungi Google Apps Script.'));
      }, timeout);

      pending.set(id, {resolve, reject, timer});
      iframe.contentWindow.postMessage({
        ktdBridge: true,
        type: 'request',
        id,
        name,
        payload
      }, '*');
    });
  }

  return { init, reload, call };
})();
