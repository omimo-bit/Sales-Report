const KtdBridge = (() => {
  let iframe = null;
  let ready = false;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let mountId = 0;
  let requestSeq = 0;

  const pending = new Map();

  function config() {
    return window.KTD_CONFIG || {};
  }

  function backendUrl() {
    const raw = String(config().GAS_WEB_APP_URL || '').trim();

    if (!raw) {
      throw new Error('URL backend Apps Script belum diisi di config.js.');
    }

    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(raw)) {
      throw new Error('URL backend harus URL Apps Script /exec.');
    }

    return raw;
  }

  function resetReadyPromise() {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
  }

  function destroyIframe() {
    if (iframe) {
      try { iframe.remove(); } catch (_) {}
    }
    iframe = null;
    ready = false;
  }

  function sendPing() {
    try {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          ktdBridge: true,
          type: 'ping'
        }, '*');
      }
    } catch (_) {}
  }

  function mount() {
    const url = backendUrl();
    const currentMount = ++mountId;

    destroyIframe();
    resetReadyPromise();

    iframe = document.createElement('iframe');
    iframe.id = 'ktdBackendBridge';
    iframe.title = 'KTD Backend Bridge';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;' +
      'border:0;left:-10000px;top:-10000px;';

    iframe.onload = () => {
      if (currentMount !== mountId) return;

      sendPing();
      setTimeout(sendPing, 300);
      setTimeout(sendPing, 900);
      setTimeout(sendPing, 1800);
    };

    iframe.onerror = () => {
      if (currentMount !== mountId) return;

      if (readyReject) {
        readyReject(new Error(
          'Backend Apps Script gagal dimuat. Periksa deployment /exec.'
        ));
      }
    };

    const sep = url.includes('?') ? '&' : '?';
    iframe.src =
      url +
      sep +
      'bridge=1' +
      '&v=' + encodeURIComponent(String(config().APP_VERSION || '1')) +
      '&t=' + Date.now();

    document.body.appendChild(iframe);
  }

  async function init(timeoutMs) {
    if (!navigator.onLine) {
      throw new Error('Perangkat sedang offline.');
    }

    if (ready) return true;

    if (!readyPromise || !iframe) {
      mount();
    }

    const limit = Number(
      timeoutMs ||
      config().BRIDGE_READY_TIMEOUT_MS ||
      12000
    );

    await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(
            'Backend belum merespons. Pastikan Apps Script sudah di-deploy sebagai Web App dan aksesnya Anyone.'
          ));
        }, limit);
      })
    ]);

    return true;
  }

  function reload() {
    if (!navigator.onLine) return;
    mount();
  }

  async function call(name, payload) {
    if (!navigator.onLine) {
      throw new Error('Perangkat sedang offline.');
    }

    await init();

    const id =
      'req-' +
      Date.now() +
      '-' +
      (++requestSeq);

    const timeout = Number(
      config().REQUEST_TIMEOUT_MS ||
      20000
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);

        reject(new Error(
          'Timeout menghubungi backend Apps Script.'
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
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);

        reject(new Error(
          'Gagal mengirim request ke backend: ' +
          (err?.message || String(err))
        ));
      }
    });
  }

  async function health() {
    return call('healthCheck');
  }

  function status() {
    return {
      ready,
      iframeMounted: !!iframe,
      backendUrl: (() => {
        try { return backendUrl(); }
        catch (_) { return ''; }
      })()
    };
  }

  window.addEventListener('message', event => {
    if (!iframe || event.source !== iframe.contentWindow) {
      return;
    }

    const msg = event.data || {};

    if (!msg.ktdBridge) {
      return;
    }

    if (msg.type === 'ready') {
      ready = true;

      if (readyResolve) {
        readyResolve(true);
      }

      return;
    }

    if (
      msg.type === 'response' &&
      msg.id &&
      pending.has(msg.id)
    ) {
      const job = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(job.timer);

      if (msg.ok) {
        job.resolve(msg.result);
      } else {
        job.reject(
          new Error(
            msg.error ||
            'Backend mengembalikan error.'
          )
        );
      }
    }
  });

  window.addEventListener('online', () => {
    setTimeout(() => {
      try { reload(); } catch (_) {}
    }, 250);
  });

  return {
    init,
    reload,
    call,
    health,
    status
  };
})();
