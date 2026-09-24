const DB_NAME = 'ktd_sales_offline_v4';
const DB_VERSION = 1;

const STORE_QUEUE = 'queue';
const STORE_META = 'meta';

const KEY_TOKEN = 'authToken';
const KEY_SESSION = 'cachedSession';
const KEY_DEVICE = 'deviceId';
const KEY_VENUES = 'venueCache';
const KEY_LAST_SYNC = 'lastSuccessfulSync';
const KEY_OFFLINE_SINCE = 'offlineSince';

const STATIC_VENUES = [
  {
    key:'STATIC|Synchronize Festival|Main Booth',
    lokasi:'Main Booth',
    event:'Synchronize Festival',
    map:''
  },
  {
    key:'STATIC|Synchronize Festival|Drink Stall 1',
    lokasi:'Drink Stall 1',
    event:'Synchronize Festival',
    map:''
  },
  {
    key:'STATIC|Synchronize Festival|Drink Stall 2',
    lokasi:'Drink Stall 2',
    event:'Synchronize Festival',
    map:''
  },
  {
    key:'STATIC|Synchronize Festival|Drink Stall 3',
    lokasi:'Drink Stall 3',
    event:'Synchronize Festival',
    map:''
  },
  {
    key:'STATIC|Synchronize Festival|Drink Stall 4',
    lokasi:'Drink Stall 4',
    event:'Synchronize Festival',
    map:''
  }
];

let db = null;
let session = null;
let sessionToken = '';
let products = [];
let venues = [...STATIC_VENUES];
let cart = {};
let selectedCategory = 'ALL';
let payment = 'Cash';
let syncInProgress = false;
let serverSummary = emptySummary();

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    db = await openDb();
  } catch (e) {
    alert(
      'Penyimpanan offline tidak dapat dibuka: ' +
      (e?.message || String(e))
    );
    return;
  }

  bindEvents();
  renderVenueSelect();
  updateNetworkState();

  await ensureDeviceId();

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  const token = await metaGet(KEY_TOKEN);
  const cache = await metaGet(KEY_SESSION);

  if (token && cache && cache.session) {
    enterApp(token, cache, true);

    if (navigator.onLine) {
      setTimeout(restoreOnlineSession, 400);
      setTimeout(syncQueue, 1200);
    }
  } else {
    showLogin();

    if (navigator.onLine) {
      setTimeout(checkBackend, 150);
    } else {
      setBackendStatus(
        'OFFLINE • login baru membutuhkan internet',
        false
      );
    }
  }

  const interval = Number(
    window.KTD_CONFIG?.AUTO_SYNC_MS ||
    30000
  );

  setInterval(() => {
    updateOfflineMetrics();

    if (navigator.onLine && session) {
      syncQueue();
    }
  }, interval);

  updateOfflineMetrics();
}

function bindEvents() {
  $('#loginBtn').addEventListener('click', login);
  $('#testBackendBtn').addEventListener('click', checkBackend);
  $('#logoutBtn').addEventListener('click', logout);
  $('#saveBtn').addEventListener('click', saveOrder);
  $('#syncBtn').addEventListener('click', syncQueue);
  $('#refreshSummaryBtn').addEventListener('click', () => refreshMySummary(true));

  $('#clearCartBtn').addEventListener('click', () => {
    cart = {};
    renderProducts();
    renderCart();
  });

  $$('.payment').forEach(btn => {
    btn.addEventListener('click', () => {
      payment = btn.dataset.value || 'Cash';

      $$('.payment').forEach(x => {
        x.classList.toggle(
          'active',
          x === btn
        );
      });
    });
  });

  $('#password').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      login();
    }
  });
}

async function checkBackend() {
  if (!navigator.onLine) {
    setBackendStatus(
      'OFFLINE • backend tidak dapat dicek',
      false
    );
    return false;
  }

  setBackendStatus(
    'Menghubungkan ke backend...',
    null
  );

  try {
    KtdBridge.reload();

    await KtdBridge.init(
      Number(
        window.KTD_CONFIG?.BRIDGE_READY_TIMEOUT_MS ||
        12000
      )
    );

    const health = await KtdBridge.health();

    if (!health || !health.ok) {
      throw new Error(
        'Backend merespons tetapi statusnya tidak siap.'
      );
    }

    const bootstrap =
      await KtdBridge.call(
        'publicBootstrap'
      );

    if (
      bootstrap &&
      Array.isArray(bootstrap.venues) &&
      bootstrap.venues.length
    ) {
      venues = bootstrap.venues;
      await metaSet(KEY_VENUES, venues);
      renderVenueSelect();
    }

    setBackendStatus(
      'Kita telah terhubung',
      true
    );

    return true;
  } catch (e) {
    setBackendStatus(
      e?.message || String(e),
      false
    );

    return false;
  }
}

async function login() {
  if (!navigator.onLine) {
    showMessage(
      '#loginMsg',
      'Login baru membutuhkan internet.',
      false
    );
    return;
  }

  const username =
    $('#username').value.trim();

  const password =
    $('#password').value;

  const venueKey =
    $('#venue').value;

  if (
    !username ||
    !password ||
    !venueKey
  ) {
    showMessage(
      '#loginMsg',
      'Lengkapi username, password, dan lokasi venue.',
      false
    );
    return;
  }

  setButton(
    '#loginBtn',
    true,
    'MEMERIKSA...'
  );

  showMessage(
    '#loginMsg',
    '',
    false
  );

  try {
    const ready =
      await checkBackend();

    if (!ready) {
      throw new Error(
        'Backend belum siap. Tekan TES KONEKSI dan periksa pesan di layar.'
      );
    }

    const response =
      await KtdBridge.call(
        'login',
        {
          username,
          password,
          venueKey
        }
      );

    if (
      !response ||
      !response.token ||
      !response.session
    ) {
      throw new Error(
        'Respons login backend tidak lengkap.'
      );
    }

    await metaSet(
      KEY_TOKEN,
      response.token
    );

    await metaSet(
      KEY_SESSION,
      response
    );

    await metaSet(
      KEY_VENUES,
      response.venues || venues
    );

    $('#password').value = '';

    enterApp(
      response.token,
      response,
      false
    );
  } catch (e) {
    showMessage(
      '#loginMsg',
      e?.message || String(e),
      false
    );
  } finally {
    setButton(
      '#loginBtn',
      false,
      'MASUK'
    );
  }
}

function enterApp(
  token,
  response,
  offlineRestore
) {
  sessionToken =
    String(token || '');

  session =
    response.session || null;

  products =
    Array.isArray(response.products)
      ? response.products
      : [];

  venues =
    Array.isArray(response.venues) &&
    response.venues.length
      ? response.venues
      : venues;

  cart = {};

  $('#loginView')
    .classList.add('hidden');

  $('#salesView')
    .classList.remove('hidden');

  $('#userName').textContent =
    session?.namaUser ||
    session?.username ||
    'User';

  $('#venueLabel').textContent =
    [
      session?.lokasi,
      session?.event
    ]
    .filter(Boolean)
    .join(' • ');

  selectedCategory = 'ALL';

  renderCategories();
  renderProducts();
  renderCart();
  refreshCounters();
  refreshMySummary(false);

  if (
    !offlineRestore &&
    navigator.onLine
  ) {
    setTimeout(syncQueue, 600);
  }
}

async function restoreOnlineSession() {
  if (!navigator.onLine) return;

  const token =
    await metaGet(KEY_TOKEN);

  if (!token) {
    showLogin();
    return;
  }

  try {
    await KtdBridge.init();

    const response =
      await KtdBridge.call(
        'restoreSession',
        token
      );

    await metaSet(
      KEY_SESSION,
      response
    );

    sessionToken = token;
    session = response.session;
    products =
      response.products || products;
    venues =
      response.venues || venues;

    renderCategories();
    renderProducts();
    renderCart();

    await syncQueue();
    await refreshMySummary(true);
  } catch (e) {
    const msg =
      String(
        e?.message || e || ''
      ).toLowerCase();

    if (
      msg.includes('session') ||
      msg.includes('aktif') ||
      msg.includes('token')
    ) {
      await metaDel(KEY_TOKEN);
      await metaDel(KEY_SESSION);

      sessionToken = '';
      session = null;
      products = [];

      showLogin();

      showMessage(
        '#loginMsg',
        'Session online tidak valid. Silakan login kembali. Data pending tetap tersimpan.',
        false
      );
    }
  }
}

async function logout() {
  const pending =
    session
      ? await queueCountForUser(
          session.username
        )
      : 0;

  if (pending > 0) {
    const ok = confirm(
      `Ada ${pending} transaksi belum tersinkron. ` +
      'Logout sekarang? Data tetap disimpan di perangkat.'
    );

    if (!ok) return;
  }

  await metaDel(KEY_TOKEN);
  await metaDel(KEY_SESSION);

  sessionToken = '';
  session = null;
  products = [];
  cart = {};
  serverSummary = emptySummary();

  $('#salesView')
    .classList.add('hidden');

  $('#loginView')
    .classList.remove('hidden');

  renderVenueSelect();

  if (navigator.onLine) {
    setTimeout(checkBackend, 150);
  }
}

function showLogin() {
  $('#salesView')
    .classList.add('hidden');

  $('#loginView')
    .classList.remove('hidden');

  metaGet(KEY_VENUES)
    .then(cached => {
      if (
        Array.isArray(cached) &&
        cached.length
      ) {
        venues = cached;
      }

      renderVenueSelect();
    })
    .catch(() => {
      renderVenueSelect();
    });
}

function renderVenueSelect() {
  const source =
    Array.isArray(venues) &&
    venues.length
      ? venues
      : STATIC_VENUES;

  const current =
    $('#venue')?.value || '';

  const unique =
    new Map();

  source.forEach(v => {
    if (
      v &&
      v.key &&
      v.lokasi
    ) {
      unique.set(
        String(v.key),
        v
      );
    }
  });

  const list =
    [...unique.values()];

  $('#venue').innerHTML =
    '<option value="">Pilih lokasi venue</option>' +
    list.map(v => {
      return (
        '<option value="' +
        escapeHtml(v.key) +
        '">' +
        escapeHtml(v.lokasi) +
        ' — ' +
        escapeHtml(v.event || '') +
        '</option>'
      );
    }).join('');

  if (
    current &&
    unique.has(current)
  ) {
    $('#venue').value = current;
  }
}

function renderCategories() {
  const cats =
    [
      'ALL',
      ...new Set(
        products.map(
          p =>
            p.subKategori ||
            'LAINNYA'
        )
      )
    ];

  $('#productTabs').innerHTML =
    cats.map(cat => {
      const active =
        cat === selectedCategory
          ? ' active'
          : '';

      const label =
        cat === 'ALL'
          ? 'SEMUA'
          : cat;

      return (
        '<button class="category-tab' +
        active +
        '" data-cat="' +
        escapeHtml(cat) +
        '" type="button">' +
        escapeHtml(label) +
        '</button>'
      );
    }).join('');

  $$('.category-tab')
    .forEach(btn => {
      btn.addEventListener(
        'click',
        () => {
          selectedCategory =
            btn.dataset.cat;

          renderCategories();
          renderProducts();
        }
      );
    });
}

function renderProducts() {
  const filtered =
    products.filter(p => {
      return (
        selectedCategory === 'ALL' ||
        String(p.subKategori) ===
          selectedCategory
      );
    });

  if (!filtered.length) {
    $('#productList').innerHTML =
      '<div class="empty-state">Produk belum tersedia.</div>';
    return;
  }

  $('#productList').innerHTML =
    filtered.map(p => {
      const qty =
        Number(
          cart[p.kodeProduk] || 0
        );

      return (
        '<div class="product-card' +
        (qty > 0 ? ' in-cart' : '') +
        '">' +

        '<div>' +
        '<b>' +
        escapeHtml(p.namaProduk) +
        '</b>' +

        '<span class="price">' +
        money(p.harga) +
        ' / ' +
        escapeHtml(p.satuan || '') +
        '</span>' +
        '</div>' +

        '<div class="product-controls">' +
        '<button data-action="minus" data-code="' +
        escapeHtml(p.kodeProduk) +
        '" type="button">−</button>' +

        '<strong>' +
        qty +
        '</strong>' +

        '<button class="plus" data-action="plus" data-code="' +
        escapeHtml(p.kodeProduk) +
        '" type="button">+</button>' +
        '</div>' +

        '</div>'
      );
    }).join('');

  $$('[data-action]')
    .forEach(btn => {
      btn.addEventListener(
        'click',
        () => {
          changeCart(
            btn.dataset.code,
            btn.dataset.action === 'plus'
              ? 1
              : -1
          );
        }
      );
    });
}

function changeCart(
  code,
  delta
) {
  const next =
    Math.max(
      0,
      Math.min(
        999,
        Number(
          cart[code] || 0
        ) + delta
      )
    );

  if (next === 0) {
    delete cart[code];
  } else {
    cart[code] = next;
  }

  renderProducts();
  renderCart();

  if (navigator.vibrate) {
    navigator.vibrate(10);
  }
}

function renderCart() {
  const lines =
    products.filter(
      p =>
        Number(
          cart[p.kodeProduk] || 0
        ) > 0
    );

  const totalQty =
    lines.reduce(
      (sum, p) =>
        sum +
        Number(
          cart[p.kodeProduk]
        ),
      0
    );

  const totalValue =
    lines.reduce(
      (sum, p) =>
        sum +
        Number(
          cart[p.kodeProduk]
        ) *
        Number(
          p.harga || 0
        ),
      0
    );

  $('#cartInfo').textContent =
    lines.length
      ? `${lines.length} produk • ${totalQty} qty`
      : 'Belum ada item';

  $('#cartList').innerHTML =
    lines.length
      ? lines.map(p => {
          const qty =
            Number(
              cart[p.kodeProduk]
            );

          return (
            '<div class="cart-row">' +
            '<div>' +
            '<b>' +
            escapeHtml(p.namaProduk) +
            '</b>' +
            '<span>' +
            qty +
            ' × ' +
            money(p.harga) +
            '</span>' +
            '</div>' +
            '<strong>' +
            money(
              qty *
              Number(
                p.harga || 0
              )
            ) +
            '</strong>' +
            '</div>'
          );
        }).join('')
      : '<div class="cart-empty">Pilih satu atau beberapa produk.</div>';

  $('#total').textContent =
    money(totalValue);

  $('#totalQty').textContent =
    `${totalQty} qty`;
}

async function saveOrder() {
  if (!session) return;

  const lines =
    products.filter(
      p =>
        Number(
          cart[p.kodeProduk] || 0
        ) > 0
    );

  if (!lines.length) {
    showMessage(
      '#saveMsg',
      'Pilih minimal 1 item.',
      false
    );
    return;
  }

  const now =
    Date.now();

  const orderId =
    randomId();

  const deviceId =
    await metaGet(KEY_DEVICE);

  const note =
    $('#note').value.trim();

  const records =
    lines.map((product, index) => {
      return {
        idTransaksi: randomId(),
        idPesanan: orderId,
        clientTimestamp:
          now + index,
        kodeProduk:
          product.kodeProduk,
        namaProduk:
          product.namaProduk,
        satuan:
          product.satuan,
        harga:
          Number(
            product.harga || 0
          ),
        qty:
          Number(
            cart[
              product.kodeProduk
            ]
          ),
        metodePembayaran:
          payment,
        keterangan:
          note,
        deviceId,
        createdAt:
          now + index,
        syncStatus:
          'PENDING',
        ownerUsername:
          String(
            session.username || ''
          ).toLowerCase(),
        lokasi:
          session.lokasi || '',
        event:
          session.event || ''
      };
    });

  await queuePutMany(records);

  cart = {};
  $('#note').value = '';

  renderProducts();
  renderCart();

  showMessage(
    '#saveMsg',
    navigator.onLine
      ? 'Pesanan tersimpan. Menyinkronkan ke Google Sheet...'
      : 'Pesanan tersimpan OFFLINE di perangkat.',
    true
  );

  await refreshCounters();
  await refreshMySummary(false);

  if (navigator.vibrate) {
    navigator.vibrate(
      [20, 30, 20]
    );
  }

  if (navigator.onLine) {
    setTimeout(syncQueue, 250);
  }
}

async function syncQueue() {
  if (
    syncInProgress ||
    !session ||
    !navigator.onLine
  ) {
    return;
  }

  syncInProgress = true;
  updateNetworkState();

  try {
    await KtdBridge.init();

    let totalSynced = 0;

    while (navigator.onLine) {
      const pending =
        await getPendingForUser(
          session.username,
          Number(
            window.KTD_CONFIG
              ?.SYNC_BATCH_SIZE ||
            120
          )
        );

      if (!pending.length) {
        break;
      }

      pending.forEach(row => {
        row.syncStatus =
          'SYNCING';

        row.lastSyncAttempt =
          new Date()
            .toISOString();
      });

      await queuePutMany(
        pending
      );

      await refreshCounters();

      let result;

      try {
        result =
          await KtdBridge.call(
            'syncTransactions',
            {
              token:
                sessionToken,
              records:
                pending
            }
          );
      } catch (err) {
        pending.forEach(row => {
          row.syncStatus =
            'PENDING';

          row.lastSyncError =
            String(
              err?.message ||
              err
            );
        });

        await queuePutMany(
          pending
        );

        throw err;
      }

      const accepted =
        new Set([
          ...(result?.accepted || []),
          ...(result?.duplicates || [])
        ]);

      const rejectedMap =
        new Map(
          (result?.rejected || [])
            .map(x => [
              x.idTransaksi,
              x.error
            ])
        );

      for (const row of pending) {
        if (
          accepted.has(
            row.idTransaksi
          )
        ) {
          await queueDelete(
            row.idTransaksi
          );

          totalSynced++;
        } else if (
          rejectedMap.has(
            row.idTransaksi
          )
        ) {
          // Rejected dari backend berarti data record bermasalah,
          // bukan sekadar gangguan internet. Tandai ERROR agar
          // tidak terjadi loop sync tanpa akhir.
          row.syncStatus =
            'ERROR';

          row.lastSyncError =
            rejectedMap.get(
              row.idTransaksi
            );

          await queuePut(
            row
          );
        } else {
          // Belum dikonfirmasi server. Biarkan PENDING untuk retry berikutnya.
          row.syncStatus =
            'PENDING';

          row.lastSyncError =
            'Server belum mengonfirmasi transaksi.';

          await queuePut(
            row
          );
        }
      }

      await metaSet(
        KEY_LAST_SYNC,
        new Date()
          .toISOString()
      );

      await refreshCounters();

      await sleep(60);

      if (
        pending.length <
        Number(
          window.KTD_CONFIG
            ?.SYNC_BATCH_SIZE ||
          120
        )
      ) {
        break;
      }
    }

    if (totalSynced > 0) {
      await loadServerSummary();
      await refreshMySummary(false);

      showMessage(
        '#saveMsg',
        `${formatNumber(totalSynced)} transaksi berhasil disinkronkan.`,
        true
      );
    }
  } catch (e) {
    showMessage(
      '#saveMsg',
      'Sync tertunda: ' +
      (e?.message || String(e)) +
      ' • Data tetap aman di perangkat.',
      false
    );
  } finally {
    syncInProgress = false;
    updateNetworkState();
    updateOfflineMetrics();
  }
}

async function loadServerSummary() {
  if (
    !navigator.onLine ||
    !session
  ) {
    return serverSummary;
  }

  try {
    serverSummary =
      await KtdBridge.call(
        'getMySalesSummary',
        sessionToken
      );

    await metaSet(
      'summary:' +
      String(
        session.username
      ).toLowerCase(),
      serverSummary
    );
  } catch (_) {
    const cached =
      await metaGet(
        'summary:' +
        String(
          session.username
        ).toLowerCase()
      );

    if (cached) {
      serverSummary = cached;
    }
  }

  return serverSummary;
}

async function refreshMySummary(
  forceNetwork
) {
  if (!session) return;

  const key =
    'summary:' +
    String(
      session.username
    ).toLowerCase();

  const cached =
    await metaGet(key);

  if (cached) {
    serverSummary = cached;
  }

  const offline =
    await getOfflineSummaryForUser(
      session.username
    );

  renderMySummary(
    mergeSummaries(
      serverSummary,
      offline
    )
  );

  if (
    forceNetwork &&
    navigator.onLine
  ) {
    await loadServerSummary();

    const offlineNow =
      await getOfflineSummaryForUser(
        session.username
      );

    renderMySummary(
      mergeSummaries(
        serverSummary,
        offlineNow
      )
    );
  }
}

function renderMySummary(data) {
  $('#myTotalQty').textContent =
    formatNumber(
      data.totalQty
    );

  $('#myTotalValue').textContent =
    money(
      data.totalValue
    );

  $('#itemSummary')
    .classList.toggle(
      'empty-state',
      !data.byItem.length
    );

  $('#itemSummary').innerHTML =
    data.byItem.length
      ? data.byItem.map(x => {
          return (
            '<div class="summary-row">' +
            '<div>' +
            '<b>' +
            escapeHtml(
              x.namaProduk ||
              x.kodeProduk ||
              '-'
            ) +
            '</b>' +
            '<small>' +
            escapeHtml(
              x.kodeProduk ||
              ''
            ) +
            (
              x.satuan
                ? ' • ' +
                  escapeHtml(
                    x.satuan
                  )
                : ''
            ) +
            '</small>' +
            '</div>' +

            '<div class="numbers">' +
            '<strong>' +
            formatNumber(
              x.qty
            ) +
            ' qty</strong>' +
            '<span>' +
            money(
              x.value
            ) +
            '</span>' +
            '</div>' +
            '</div>'
          );
        }).join('')
      : 'Belum ada penjualan.';

  $('#locationSummary')
    .classList.toggle(
      'empty-state',
      !data.byLocation.length
    );

  $('#locationSummary').innerHTML =
    data.byLocation.length
      ? data.byLocation.map(x => {
          return (
            '<div class="summary-row">' +
            '<div>' +
            '<b>' +
            escapeHtml(
              x.lokasi ||
              '-'
            ) +
            '</b>' +
            '<small>Penjualan akun ' +
            escapeHtml(
              session.username
            ) +
            '</small>' +
            '</div>' +

            '<div class="numbers">' +
            '<strong>' +
            formatNumber(
              x.qty
            ) +
            ' qty</strong>' +
            '<span>' +
            money(
              x.value
            ) +
            '</span>' +
            '</div>' +
            '</div>'
          );
        }).join('')
      : 'Belum ada penjualan.';
}

function mergeSummaries(a, b) {
  const result =
    emptySummary();

  result.totalQty =
    Number(a?.totalQty || 0) +
    Number(b?.totalQty || 0);

  result.totalValue =
    Number(a?.totalValue || 0) +
    Number(b?.totalValue || 0);

  const itemMap =
    new Map();

  const locationMap =
    new Map();

  [
    ...(a?.byItem || []),
    ...(b?.byItem || [])
  ].forEach(x => {
    const key =
      x.kodeProduk ||
      x.namaProduk;

    if (!itemMap.has(key)) {
      itemMap.set(
        key,
        {
          kodeProduk:
            x.kodeProduk || '',
          namaProduk:
            x.namaProduk || '',
          satuan:
            x.satuan || '',
          qty:0,
          value:0
        }
      );
    }

    const target =
      itemMap.get(key);

    target.qty +=
      Number(
        x.qty || 0
      );

    target.value +=
      Number(
        x.value || 0
      );
  });

  [
    ...(a?.byLocation || []),
    ...(b?.byLocation || [])
  ].forEach(x => {
    const key =
      x.lokasi ||
      'Tanpa Lokasi';

    if (!locationMap.has(key)) {
      locationMap.set(
        key,
        {
          lokasi:key,
          qty:0,
          value:0
        }
      );
    }

    const target =
      locationMap.get(key);

    target.qty +=
      Number(
        x.qty || 0
      );

    target.value +=
      Number(
        x.value || 0
      );
  });

  result.byItem =
    [...itemMap.values()]
      .sort(
        (x, y) =>
          String(
            x.namaProduk
          ).localeCompare(
            String(
              y.namaProduk
            )
          )
      );

  result.byLocation =
    [...locationMap.values()]
      .sort(
        (x, y) =>
          String(
            x.lokasi
          ).localeCompare(
            String(
              y.lokasi
            )
          )
      );

  return result;
}

async function getOfflineSummaryForUser(
  username
) {
  const uname =
    String(
      username || ''
    ).toLowerCase();

  const all =
    await getAllQueue();

  const mine =
    all.filter(x => {
      return (
        String(
          x.ownerUsername || ''
        ).toLowerCase() ===
        uname
      );
    });

  const out =
    emptySummary();

  const itemMap =
    new Map();

  const locationMap =
    new Map();

  mine.forEach(x => {
    const product =
      products.find(p => {
        return (
          String(
            p.kodeProduk
          ) ===
          String(
            x.kodeProduk
          )
        );
      });

    const qty =
      Number(
        x.qty || 0
      );

    const price =
      Number(
        x.harga ??
        product?.harga ??
        0
      );

    const value =
      qty * price;

    const kode =
      x.kodeProduk || '';

    const nama =
      x.namaProduk ||
      product?.namaProduk ||
      kode;

    const satuan =
      x.satuan ||
      product?.satuan ||
      '';

    const lokasi =
      x.lokasi ||
      session?.lokasi ||
      'Tanpa Lokasi';

    out.totalQty += qty;
    out.totalValue += value;

    if (!itemMap.has(kode)) {
      itemMap.set(
        kode,
        {
          kodeProduk:kode,
          namaProduk:nama,
          satuan,
          qty:0,
          value:0
        }
      );
    }

    itemMap.get(kode).qty += qty;
    itemMap.get(kode).value += value;

    if (!locationMap.has(lokasi)) {
      locationMap.set(
        lokasi,
        {
          lokasi,
          qty:0,
          value:0
        }
      );
    }

    locationMap.get(lokasi).qty += qty;
    locationMap.get(lokasi).value += value;
  });

  out.byItem =
    [...itemMap.values()];

  out.byLocation =
    [...locationMap.values()];

  return out;
}

async function refreshCounters() {
  if (!session) return;

  const count =
    await queueCountForUser(
      session.username
    );

  $('#pendingCount').textContent =
    formatNumber(count);

  $('#pendingTop').textContent =
    formatNumber(count);

  updateOfflineMetrics();
}

async function updateOfflineMetrics() {
  const lastSync =
    await metaGet(
      KEY_LAST_SYNC
    );

  const offlineSince =
    await metaGet(
      KEY_OFFLINE_SINCE
    );

  $('#lastSync').textContent =
    lastSync
      ? formatTimeAgo(
          lastSync
        )
      : 'Belum pernah';

  if (
    navigator.onLine ||
    !offlineSince
  ) {
    $('#offlineDuration').textContent =
      '0m';
  } else {
    const diff =
      Math.max(
        0,
        Date.now() -
        new Date(
          offlineSince
        ).getTime()
      );

    $('#offlineDuration').textContent =
      formatDuration(diff);
  }

  if (session) {
    $('#offlineToday').textContent =
      formatNumber(
        await queueCountForUser(
          session.username
        )
      );
  }
}

async function onOnline() {
  updateNetworkState();
  await metaSet(
    KEY_OFFLINE_SINCE,
    null
  );

  setBackendStatus(
    'Internet kembali • menghubungkan backend...',
    null
  );

  try {
    KtdBridge.reload();

    await KtdBridge.init();

    setBackendStatus(
      'Backend siap',
      true
    );

    if (session) {
      await restoreOnlineSession();
      await syncQueue();
    } else {
      await checkBackend();
    }
  } catch (e) {
    setBackendStatus(
      e?.message || String(e),
      false
    );
  }
}

async function onOffline() {
  updateNetworkState();

  const existing =
    await metaGet(
      KEY_OFFLINE_SINCE
    );

  if (!existing) {
    await metaSet(
      KEY_OFFLINE_SINCE,
      new Date()
        .toISOString()
    );
  }

  setBackendStatus(
    'OFFLINE • data tetap disimpan lokal',
    false
  );

  await refreshMySummary(false);
}

function updateNetworkState() {
  const online =
    navigator.onLine;

  $('#offlineBar')
    .classList.toggle(
      'hidden',
      online
    );

  if ($('#netStatus')) {
    $('#netStatus').textContent =
      syncInProgress
        ? 'SYNCING...'
        : (
          online
            ? 'ONLINE'
            : 'OFFLINE'
        );
  }
}

function setBackendStatus(
  text,
  ok
) {
  const el =
    $('#backendStatus');

  if (!el) return;

  el.textContent =
    String(
      text || ''
    );

  el.style.color =
    ok === true
      ? '#067647'
      : (
        ok === false
          ? '#B42318'
          : '#727272'
      );
}

function showMessage(
  selector,
  text,
  ok
) {
  const el =
    $(selector);

  if (!el) return;

  el.textContent =
    String(
      text || ''
    );

  el.classList.toggle(
    'ok',
    !!ok
  );
}

function setButton(
  selector,
  disabled,
  label
) {
  const btn =
    $(selector);

  if (!btn) return;

  btn.disabled =
    !!disabled;

  btn.textContent =
    label;
}

function emptySummary() {
  return {
    totalQty:0,
    totalValue:0,
    byItem:[],
    byLocation:[]
  };
}

function money(value) {
  return (
    'Rp' +
    new Intl.NumberFormat(
      'id-ID',
      {
        maximumFractionDigits:0
      }
    ).format(
      Number(
        value || 0
      )
    )
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat(
    'id-ID'
  ).format(
    Number(
      value || 0
    )
  );
}

function formatTimeAgo(
  iso
) {
  const date =
    new Date(iso);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return '-';
  }

  const diff =
    Date.now() -
    date.getTime();

  if (diff < 60000) {
    return 'baru saja';
  }

  if (diff < 3600000) {
    return (
      Math.floor(
        diff / 60000
      ) +
      'm lalu'
    );
  }

  return date
    .toLocaleTimeString(
      'id-ID',
      {
        hour:'2-digit',
        minute:'2-digit'
      }
    );
}

function formatDuration(ms) {
  const min =
    Math.floor(
      ms / 60000
    );

  if (min < 60) {
    return min + 'm';
  }

  const h =
    Math.floor(
      min / 60
    );

  const m =
    min % 60;

  return (
    h +
    'j ' +
    m +
    'm'
  );
}

function escapeHtml(value) {
  return String(
    value ?? ''
  )
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function randomId() {
  if (
    window.crypto &&
    crypto.randomUUID
  ) {
    return (
      crypto.randomUUID()
        .replaceAll('-','')
        .slice(0,16)
        .toUpperCase()
    );
  }

  return (
    Date.now()
      .toString(36) +
    Math.random()
      .toString(36)
      .slice(2,10)
  )
    .toUpperCase()
    .slice(0,16);
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

/* =========================
   IndexedDB
   ========================= */

function openDb() {
  return new Promise(
    (resolve, reject) => {
      const req =
        indexedDB.open(
          DB_NAME,
          DB_VERSION
        );

      req.onupgradeneeded =
        event => {
          const idb =
            event.target.result;

          if (
            !idb.objectStoreNames
              .contains(STORE_QUEUE)
          ) {
            idb.createObjectStore(
              STORE_QUEUE,
              {
                keyPath:'idTransaksi'
              }
            );
          }

          if (
            !idb.objectStoreNames
              .contains(STORE_META)
          ) {
            idb.createObjectStore(
              STORE_META
            );
          }
        };

      req.onsuccess =
        () =>
          resolve(req.result);

      req.onerror =
        () =>
          reject(
            req.error ||
            new Error(
              'IndexedDB gagal dibuka.'
            )
          );
    }
  );
}

function idbStore(
  name,
  mode
) {
  return db
    .transaction(
      name,
      mode
    )
    .objectStore(name);
}

function requestPromise(req) {
  return new Promise(
    (resolve, reject) => {
      req.onsuccess =
        () =>
          resolve(req.result);

      req.onerror =
        () =>
          reject(req.error);
    }
  );
}

async function metaGet(key) {
  return requestPromise(
    idbStore(
      STORE_META,
      'readonly'
    ).get(key)
  );
}

async function metaSet(
  key,
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return metaDel(key);
  }

  return requestPromise(
    idbStore(
      STORE_META,
      'readwrite'
    ).put(
      value,
      key
    )
  );
}

async function metaDel(key) {
  return requestPromise(
    idbStore(
      STORE_META,
      'readwrite'
    ).delete(key)
  );
}

async function ensureDeviceId() {
  let id =
    await metaGet(KEY_DEVICE);

  if (!id) {
    id =
      'DEV-' +
      randomId();

    await metaSet(
      KEY_DEVICE,
      id
    );
  }

  return id;
}

async function queuePut(item) {
  return requestPromise(
    idbStore(
      STORE_QUEUE,
      'readwrite'
    ).put(item)
  );
}

async function queuePutMany(items) {
  if (!items.length) return;

  return new Promise(
    (resolve, reject) => {
      const tx =
        db.transaction(
          STORE_QUEUE,
          'readwrite'
        );

      const store =
        tx.objectStore(
          STORE_QUEUE
        );

      items.forEach(
        item =>
          store.put(item)
      );

      tx.oncomplete =
        () => resolve();

      tx.onerror =
        () =>
          reject(
            tx.error ||
            new Error(
              'Gagal menyimpan queue.'
            )
          );

      tx.onabort =
        () =>
          reject(
            tx.error ||
            new Error(
              'Penyimpanan queue dibatalkan.'
            )
          );
    }
  );
}

async function queueDelete(id) {
  return requestPromise(
    idbStore(
      STORE_QUEUE,
      'readwrite'
    ).delete(id)
  );
}

async function getAllQueue() {
  return requestPromise(
    idbStore(
      STORE_QUEUE,
      'readonly'
    ).getAll()
  );
}

async function getPendingForUser(
  username,
  limit
) {
  const uname =
    String(
      username || ''
    ).toLowerCase();

  const all =
    await getAllQueue();

  const selected =
    all
      .filter(row => {
        const owner =
          String(
            row.ownerUsername ||
            ''
          ).toLowerCase();

        return (
          owner === uname &&
          (
            !row.syncStatus ||
            row.syncStatus ===
              'PENDING' ||
            row.syncStatus ===
              'SYNCING'
          )
        );
      })
      .sort(
        (a, b) =>
          Number(
            a.createdAt || 0
          ) -
          Number(
            b.createdAt || 0
          )
      )
      .slice(
        0,
        Number(
          limit || 120
        )
      );

  selected.forEach(row => {
    if (
      row.syncStatus ===
      'SYNCING'
    ) {
      row.syncStatus =
        'PENDING';
    }
  });

  return selected;
}

async function queueCountForUser(
  username
) {
  const uname =
    String(
      username || ''
    ).toLowerCase();

  const all =
    await getAllQueue();

  return all.filter(row => {
    return (
      String(
        row.ownerUsername || ''
      ).toLowerCase() ===
      uname
    );
  }).length;
}
