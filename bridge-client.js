const KtdBridge = (() => {
  let iframe = null;
  let port = null;
  let ready = false;
  let clientId = '';
  let readyPromise = null;
  let readyResolve = null;
  let requestSeq = 0;
  const pending = new Map();

  function cfg() { return window.KTD_CONFIG || {}; }

  function backendUrl() {
    const raw = String(cfg().GAS_WEB_APP_URL || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(raw)) {
      throw new Error('GAS_WEB_APP_URL tidak valid.');
    }
    return raw;
  }

  function makeClientId() {
    if (crypto && crypto.randomUUID) return 'ktd_' + crypto.randomUUID().replaceAll('-', '');
    return 'ktd_' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function closePort() {
    if (port) {
      try { port.close(); } catch (_) {}
    }
    port = null;
    ready = false;
  }

  function destroyIframe() {
    if (iframe) {
      try { iframe.remove(); } catch (_) {}
    }
    iframe = null;
  }

  function rejectPending(reason) {
    const err = new Error(reason || 'Bridge terputus.');
    for (const [id, job] of pending.entries()) {
      clearTimeout(job.timer);
      job.reject(err);
      pending.delete(id);
    }
  }

  function bindPort(nextPort) {
    closePort();
    port = nextPort;
    port.onmessage = event => {
      const msg = event.data || {};
      if (!msg.ktdBridge || msg.type !== 'response' || !msg.id) return;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error || 'Backend error.'));
    };
    port.onmessageerror = () => {
      ready = false;
      rejectPending('Kanal backend terputus.');
    };
    if (port.start) port.start();
    ready = true;
    if (readyResolve) readyResolve(true);
  }

  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (!msg.ktdBridge || msg.type !== 'ready-v3' || msg.clientId !== clientId) return;
    const transferred = event.ports && event.ports[0];
    if (!transferred) return;
    bindPort(transferred);
  });

  function mount() {
    closePort();
    destroyIframe();
    rejectPending('Bridge dimuat ulang.');
    clientId = makeClientId();
    readyPromise = new Promise(resolve => { readyResolve = resolve; });

    iframe = document.createElement('iframe');
    iframe.id = 'ktdBackendBridge';
    iframe.title = 'KTD Backend Bridge';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-10000px;top:-10000px;';

    const raw = backendUrl();
    const sep = raw.includes('?') ? '&' : '?';
    iframe.src = raw + sep + 'bridge=1&clientId=' + encodeURIComponent(clientId) + '&v=' + encodeURIComponent(String(cfg().APP_VERSION || Date.now())) + '&t=' + Date.now();
    document.body.appendChild(iframe);
    return readyPromise;
  }

  async function init() {
    if (!navigator.onLine) throw new Error('Perangkat sedang offline.');
    if (ready && port) return true;
    if (!iframe || !readyPromise) mount();

    const timeout = Number(cfg().BRIDGE_READY_TIMEOUT_MS || 15000);
    try {
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge timeout.')), timeout))
      ]);
      return true;
    } catch (_) {
      mount();
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Backend Apps Script aktif tetapi Bridge belum tersambung.')), timeout))
      ]);
      return true;
    }
  }

  async function call(name, payload) {
    await init();
    if (!port) throw new Error('Bridge backend belum siap.');
    const id = 'req_' + Date.now() + '_' + (++requestSeq);
    const timeout = Number(cfg().REQUEST_TIMEOUT_MS || 30000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timeout menjalankan ' + name + '.'));
      }, timeout);
      pending.set(id, {resolve, reject, timer});
      try {
        port.postMessage({ktdBridge:true, type:'request', id, name, payload});
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        ready = false;
        reject(err);
      }
    });
  }

  function reload() { if (navigator.onLine) mount(); }
  function status() { return {ready, hasPort:!!port, hasIframe:!!iframe, clientId, backendUrl:backendUrl()}; }

  return {init, call, reload, status, health:() => call('healthCheck')};
})();
