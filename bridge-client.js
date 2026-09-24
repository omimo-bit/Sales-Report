const KtdBridge = (() => {
  let iframe = null;
  let ready = false;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let seq = 0;
  let mountSeq = 0;

  const pending = new Map();

  function backendUrl() {
    const raw = String(window.KTD_CONFIG?.GAS_WEB_APP_URL || '').trim();

    if (!raw || raw.includes('PASTE_GAS_WEB_APP')) {
      throw new Error(
        'GAS_WEB_APP_URL belum diisi di config.js.'
      );
    }

    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(raw)) {
      throw new Error(
        'GAS_WEB_APP_URL harus URL deployment Apps Script yang berakhir /exec.'
      );
    }

    return raw;
  }

  function resetReadyPromise() {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
  }

  function postPing() {
    try {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          ktdBridge: true,
          type: 'ping'
        }, '*');
      }
    } catch (e) {}
  }

  function mount() {
    const url = backendUrl();
    const thisMount = ++mountSeq;

    if (iframe) {
      try { iframe.remove(); } catch (e) {}
    }

    ready = false;
    resetReadyPromise();

    iframe = document.createElement('iframe');
    iframe.id = 'ktdBackendBridge';
    iframe.title = 'KTD Backend Bridge';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;' +
      'border:0;left:-9999px;top:-9999px;';

    iframe.onload = () => {
      if (thisMount !== mountSeq) return;

      // Handshake aktif. Ini membuat bridge lebih tahan terhadap
      // redirect /exec -> googleusercontent.
      postPing();
      setTimeout(postPing, 350);
      setTimeout(postPing, 1000);
    };

    iframe.onerror = () => {
      if (thisMount !== mountSeq) return;
      if (readyReject) {
        readyReject(new Error(
          'Backend Apps Script gagal dimuat. Periksa URL /exec dan deployment.'
        ));
      }
    };

    const sep = url.includes('?') ? '&' : '?';
    iframe.src = url + sep + 'bridge=1&t=' + Date.now();

    document.body.appendChild(iframe);
  }

  async function init(timeoutMs = 15000) {
    if (ready) return true;

    if (!readyPromise) {
      mount();
    }

    // PENTING:
    // Versi lama melakukan "await init()" tanpa timeout sehingga tombol
    // bisa berhenti di MEMERIKSA... selamanya jika Bridge tidak pernah ready.
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(
          'Backend belum merespons. Pastikan Apps Script sudah Deploy New Version, akses Anyone, dan Bridge.html tersedia.'
        ));
      }, timeoutMs))
    ]);

    return true;
  }

  function reload() {
    if (!navigator.onLine) return;

    try {
      mount();
    } catch (e) {
      ready = false;
    }
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

      if (msg.ok) {
        job.resolve(msg.result);
      } else {
        job.reject(new Error(msg.error || 'Backend error'));
      }
    }
  });

  async function call(name, payload) {
    if (!navigator.onLine) {
      throw new Error('Perangkat sedang offline.');
    }

    await init(15000);

    const id = 'req-' + Date.now() + '-' + (++seq);
    const timeout =
      Number(window.KTD_CONFIG?.REQUEST_TIMEOUT_MS || 30000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);

        reject(new Error(
          'Timeout menghubungi Google Apps Script. Periksa deployment backend.'
        ));
      }, timeout);

      pending.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        iframe.contentWindow.postMessage({
          ktdBridge: true,
          type: 'request',
          id,
          name,
          payload
        }, '*');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);

        reject(new Error(
          'Gagal mengirim request ke backend: ' +
          (e?.message || String(e))
        ));
      }
    });
  }

  function status() {
    return {
      ready,
      hasIframe: !!iframe,
      backendUrl: (() => {
        try { return backendUrl(); }
        catch (e) { return ''; }
      })()
    };
  }

  return {
    init,
    reload,
    call,
    status
  };
})();
