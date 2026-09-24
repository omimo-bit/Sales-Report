/*
 * KTD BRIDGE V3
 * GitHub Pages <-> Google Apps Script HtmlService
 *
 * Menggunakan MessageChannel karena HtmlService Apps Script berjalan
 * di sandbox iframe internal Google. Bridge inner frame mengirim MessagePort
 * langsung ke window.top (GitHub Pages).
 */
const KtdBridge = (() => {
  let iframe = null;
  let port = null;
  let ready = false;
  let currentClientId = '';
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let requestSeq = 0;
  let mountSeq = 0;

  const pending = new Map();

  function cfg() {
    return window.KTD_CONFIG || {};
  }

  function backendUrl() {
    const raw = String(cfg().GAS_WEB_APP_URL || '').trim();

    if (!raw) {
      throw new Error('GAS_WEB_APP_URL belum diisi di config.js.');
    }

    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/i.test(raw)) {
      throw new Error('GAS_WEB_APP_URL harus URL Apps Script yang berakhir /exec.');
    }

    return raw;
  }

  function randomClientId() {
    if (window.crypto && crypto.randomUUID) {
      return 'ktd_' + crypto.randomUUID().replaceAll('-', '');
    }

    return (
      'ktd_' +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }

  function createReadyPromise() {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
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

  function rejectAllPending(reason) {
    const err = new Error(reason || 'Bridge terputus.');

    for (const [id, job] of pending.entries()) {
      clearTimeout(job.timer);
      job.reject(err);
      pending.delete(id);
    }
  }

  function bindPort(newPort) {
    closePort();

    port = newPort;

    port.onmessage = event => {
      const msg = event.data || {};

      if (!msg.ktdBridge || msg.type !== 'response' || !msg.id) {
        return;
      }

      const job = pending.get(msg.id);

      if (!job) {
        return;
      }

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
    };

    port.onmessageerror = () => {
      ready = false;
      rejectAllPending('Kanal komunikasi backend terputus.');
    };

    if (port.start) {
      port.start();
    }

    ready = true;

    if (readyResolve) {
      readyResolve(true);
    }
  }

  /*
   * Bridge.html berjalan di inner sandbox iframe Google.
   * Ia mengirim MessagePort ke window.top.
   * clientId acak memastikan hanya bridge yang baru kita mount yang diterima.
   */
  window.addEventListener('message', event => {
    const msg = event.data || {};

    if (
      !msg.ktdBridge ||
      msg.type !== 'ready-v3' ||
      !currentClientId ||
      msg.clientId !== currentClientId
    ) {
      return;
    }

    const transferredPort =
      event.ports &&
      event.ports[0];

    if (!transferredPort) {
      if (readyReject) {
        readyReject(
          new Error(
            'Backend terhubung tetapi MessagePort tidak diterima. Update browser lalu coba lagi.'
          )
        );
      }
      return;
    }

    bindPort(transferredPort);
  });

  function mount() {
    const url = backendUrl();
    const localMount = ++mountSeq;

    closePort();
    destroyIframe();
    rejectAllPending('Bridge dimuat ulang.');

    currentClientId = randomClientId();
    createReadyPromise();

    iframe = document.createElement('iframe');
    iframe.id = 'ktdBackendBridge';
    iframe.title = 'KTD Backend Bridge';
    iframe.setAttribute('aria-hidden', 'true');

    iframe.style.cssText =
      'position:fixed;' +
      'width:1px;' +
      'height:1px;' +
      'opacity:0;' +
      'pointer-events:none;' +
      'border:0;' +
      'left:-10000px;' +
      'top:-10000px;';

    iframe.onerror = () => {
      if (localMount !== mountSeq) return;

      if (readyReject) {
        readyReject(
          new Error(
            'Iframe backend gagal dimuat. Periksa URL deployment Apps Script.'
          )
        );
      }
    };

    const separator =
      url.includes('?')
        ? '&'
        : '?';

    iframe.src =
      url +
      separator +
      'bridge=1' +
      '&clientId=' +
      encodeURIComponent(currentClientId) +
      '&v=' +
      encodeURIComponent(
        String(
          cfg().APP_VERSION ||
          Date.now()
        )
      ) +
      '&t=' +
      Date.now();

    document.body.appendChild(iframe);

    return readyPromise;
  }

  async function waitReady(timeoutMs) {
    const limit =
      Number(
        timeoutMs ||
        cfg().BRIDGE_READY_TIMEOUT_MS ||
        12000
      );

    await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              'Bridge Apps Script tidak memberi handshake.'
            )
          );
        }, limit);
      })
    ]);

    return true;
  }

  async function init(timeoutMs) {
    if (!navigator.onLine) {
      throw new Error('Perangkat sedang offline.');
    }

    if (ready && port) {
      return true;
    }

    if (!iframe || !readyPromise) {
      mount();
    }

    try {
      return await waitReady(timeoutMs);
    } catch (firstError) {
      // Retry sekali dengan iframe dan clientId baru.
      mount();

      try {
        return await waitReady(timeoutMs);
      } catch (_) {
        throw new Error(
          'Backend Apps Script aktif, tetapi Bridge belum tersambung. ' +
          'Pastikan Bridge.html V3 sudah tersimpan dan deployment dibuat New Version.'
        );
      }
    }
  }

  function reload() {
    if (!navigator.onLine) {
      return;
    }

    mount();
  }

  async function call(name, payload) {
    if (!navigator.onLine) {
      throw new Error('Perangkat sedang offline.');
    }

    await init();

    if (!port || !ready) {
      throw new Error('Bridge backend belum siap.');
    }

    const id =
      'req_' +
      Date.now() +
      '_' +
      (++requestSeq);

    const timeout =
      Number(
        cfg().REQUEST_TIMEOUT_MS ||
        30000
      );

    return new Promise((resolve, reject) => {
      const timer =
        setTimeout(() => {
          pending.delete(id);

          reject(
            new Error(
              'Timeout menjalankan ' +
              name +
              ' di Apps Script.'
            )
          );
        }, timeout);

      pending.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        port.postMessage({
          ktdBridge: true,
          type: 'request',
          id,
          name,
          payload
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        ready = false;

        reject(
          new Error(
            'Gagal mengirim request ke backend: ' +
            (err?.message || String(err))
          )
        );
      }
    });
  }

  function health() {
    return call('healthCheck');
  }

  function status() {
    return {
      ready,
      hasPort: !!port,
      hasIframe: !!iframe,
      clientId: currentClientId,
      backendUrl: (() => {
        try {
          return backendUrl();
        } catch (_) {
          return '';
        }
      })()
    };
  }

  return {
    init,
    reload,
    call,
    health,
    status
  };
})();
