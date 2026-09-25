const DB_NAME = 'ktd_sales_offline_v4';
const DB_VERSION = 4;
const STORE_QUEUE = 'queue';
const STORE_META = 'meta';
const STORE_PHOTOS = 'photos';
const STORE_LOGISTIC = 'logisticQueue';

const TOKEN_KEY = 'authToken';
const SESSION_CACHE_KEY = 'cachedSession';
const VENUE_CACHE_KEY = 'venueCache';
const DEVICE_KEY = 'deviceId';
const LAST_SYNC_KEY = 'lastSuccessfulSync';
const OFFLINE_SINCE_KEY = 'offlineSince';

const STATIC_VENUES = [
  {key:'STATIC|Synchronize Festival|Main Booth', lokasi:'Main Booth', event:'Synchronize Festival'},
  {key:'STATIC|Synchronize Festival|Drink Stall 1', lokasi:'Drink Stall 1', event:'Synchronize Festival'},
  {key:'STATIC|Synchronize Festival|Drink Stall 2', lokasi:'Drink Stall 2', event:'Synchronize Festival'},
  {key:'STATIC|Synchronize Festival|Drink Stall 3', lokasi:'Drink Stall 3', event:'Synchronize Festival'},
  {key:'STATIC|Synchronize Festival|Drink Stall 4', lokasi:'Drink Stall 4', event:'Synchronize Festival'}
];

let db = null;
let session = null;
let products = [];
let venues = STATIC_VENUES.slice();
let payment = 'Cash';
let selectedCategory = 'ALL';
let cart = {};
let currentPhotoId = '';
let currentPreviewUrl = '';
let syncInProgress = false;
let serverSummary = {totalQty:0,totalValue:0,byItem:[],byLocation:[]};
let currentMode = 'login';
let logisticCart = {};
let logisticCategory = 'ALL';
let logisticType = 'IN';
let logisticLocation = '';
let logisticServerSummary = {location:'',stockByItem:[],recent:[]};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

window.addEventListener('DOMContentLoaded', init);

async function init() {
  db = await openDb();
  bindEvents();
  renderVenueSelect();
  await requestPersistentStorage();
  await ensureDeviceId();
  updateNetworkState();
  registerServiceWorker();

  window.addEventListener('online', async () => {
    updateNetworkState();
    await metaSet(OFFLINE_SINCE_KEY, null);
    try { await restoreOrSync(); } catch (_) {}
    setTimeout(syncAll, 500);
  });

  window.addEventListener('offline', async () => {
    updateNetworkState();
    const existing = await metaGet(OFFLINE_SINCE_KEY);
    if (!existing) await metaSet(OFFLINE_SINCE_KEY, new Date().toISOString());
    if (isLogisticRole()) refreshLogisticSummary(false); else refreshMySummary(false);
  });

  if (!navigator.onLine) {
    const existing = await metaGet(OFFLINE_SINCE_KEY);
    if (!existing) await metaSet(OFFLINE_SINCE_KEY, new Date().toISOString());
  }

  const token = await metaGet(TOKEN_KEY);
  const cached = await metaGet(SESSION_CACHE_KEY);

  if (token && cached && cached.session) {
    enterApp(cached, true);
    await migrateLegacyQueueOwner(cached.session);
    if (navigator.onLine) {
      setTimeout(restoreOrSync, 600);
      setTimeout(syncAll, 1300);
    }
  } else {
    showLogin();
    if (navigator.onLine) setTimeout(() => checkBackend(false), 200);
  }

  setInterval(() => {
    updateMetrics();
    if (navigator.onLine && session) syncAll();
  }, Number(window.KTD_CONFIG?.AUTO_SYNC_MS || 45000));

  await updateMetrics();
}

function bindEvents() {
  $('#loginBtn').addEventListener('click', login);
  $('#testConnectionBtn').addEventListener('click', () => checkBackend(true));
  $('#logoutBtn').addEventListener('click', logout);
  $('#saveBtn').addEventListener('click', saveOrder);
  $('#syncBtn').addEventListener('click', syncAll);
  $('#refreshSummaryBtn').addEventListener('click', () => refreshMySummary(true));
  $('#clearCartBtn').addEventListener('click', () => {
    cart = {};
    renderProducts();
    renderCart();
  });

  $$('.payment').forEach(btn => {
    btn.addEventListener('click', () => {
      payment = btn.dataset.value || 'Cash';
      $$('.payment').forEach(x => x.classList.toggle('active', x === btn));
      renderQrisRequirement();
    });
  });

  $('#qrisCameraBtn').addEventListener('click', () => {
    const input = $('#qrisCameraInput');
    input.value = '';
    input.click();
  });
  $('#qrisCameraInput').addEventListener('change', handleQrisCapture);
  $('#qrisRetakeBtn').addEventListener('click', () => {
    const input = $('#qrisCameraInput');
    input.value = '';
    input.click();
  });

  $('#logisticLogoutBtn').addEventListener('click', logout);
  $('#logisticSaveBtn').addEventListener('click', saveLogisticMovement);
  $('#logisticSyncBtn').addEventListener('click', syncAll);
  $('#logisticRefreshBtn').addEventListener('click', () => refreshLogisticSummary(true));
  $('#logisticClearBtn').addEventListener('click', () => {
    logisticCart = {};
    renderLogisticProducts();
    renderLogisticCart();
  });
  $('#logisticType').addEventListener('change', event => {
    logisticType = event.target.value || 'IN';
    renderLogisticCart();
  });
  $('#logisticLocation').addEventListener('change', async event => {
    logisticLocation = event.target.value || session?.lokasi || '';
    await refreshLogisticSummary(true);
  });
}

async function checkBackend(showSuccess = true) {
  if (!navigator.onLine) {
    setBackendStatus('OFFLINE • backend tidak dapat dicek', true);
    return false;
  }

  setBackendStatus('Memeriksa backend...', false);

  let health;
  let bootstrap;

  try {
    await KtdBridge.init();
    health = await KtdBridge.call('healthCheck');
    bootstrap = await KtdBridge.call('publicBootstrap');
  } catch (err) {
    setBackendStatus('Backend belum merespons • ' + (err?.message || String(err)), true);
    if (showSuccess) console.error('Backend/Bridge error:', err);
    return false;
  }

  if (!health?.ok) {
    setBackendStatus('Backend merespons tetapi healthCheck belum OK.', true);
    return false;
  }

  venues = Array.isArray(bootstrap?.venues) && bootstrap.venues.length
    ? bootstrap.venues
    : STATIC_VENUES.slice();
  renderVenueSelect();

  try {
    await metaSet(VENUE_CACHE_KEY, venues);
    setBackendStatus('Backend siap • Google Sheets terhubung', false, true);
  } catch (err) {
    console.error('Local IndexedDB cache error:', err);
    setBackendStatus('Backend siap • cache lokal mode kompatibilitas', false, true);
  }

  return true;
}

function setBackendStatus(text, isError = false, isSuccess = false) {
  const el = $('#backendStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('success', !!isSuccess);
}

function renderVenueSelect() {
  const combined = new Map(STATIC_VENUES.map(v => [v.key, v]));
  (venues || []).forEach(v => combined.set(v.key, v));
  const all = Array.from(combined.values());
  $('#venue').innerHTML = '<option value="">Pilih lokasi venue</option>' +
    all.map(v => `<option value="${esc(v.key)}">${esc(v.lokasi)} — ${esc(v.event)}</option>`).join('');
}

async function login() {
  if (!navigator.onLine) {
    showMsg('#loginMsg', 'Login pertama kali memerlukan internet.', true);
    return;
  }

  const username = $('#username').value.trim();
  const password = $('#password').value;
  const venueKey = $('#venue').value;

  if (!username || !password || !venueKey) {
    showMsg('#loginMsg', 'Lengkapi username, password, dan lokasi venue.', true);
    return;
  }

  setButton('#loginBtn', true, 'MEMERIKSA...');
  showMsg('#loginMsg', '');

  try {
    const backendReady = await checkBackend(false);
    if (!backendReady) throw new Error('Backend belum siap. Tekan TES KONEKSI.');

    const result = await KtdBridge.call('login', {username, password, venueKey});
    await metaSet(TOKEN_KEY, result.token);
    await metaSet(SESSION_CACHE_KEY, result);
    await metaSet(VENUE_CACHE_KEY, result.venues || STATIC_VENUES);
    $('#password').value = '';
    enterApp(result, false);
    setTimeout(syncAll, 600);
  } catch (err) {
    showMsg('#loginMsg', err?.message || String(err), true);
  } finally {
    setButton('#loginBtn', false, 'MASUK');
  }
}

function enterApp(result, offlineRestore) {
  session = result.session;
  products = result.products || [];
  venues = result.venues || venues;
  cart = {};
  logisticCart = {};
  payment = 'Cash';
  selectedCategory = 'ALL';
  logisticCategory = 'ALL';
  logisticType = 'IN';

  $('#loginView').classList.add('hidden');
  $('#salesView').classList.add('hidden');
  $('#logisticsView').classList.add('hidden');

  if (isLogisticRole()) {
    currentMode = 'logistic';
    $('#logisticsView').classList.remove('hidden');
    $('#logisticUserName').textContent = session.namaUser || session.username;
    $('#logisticVenueLabel').textContent = `${session.lokasi} • ${session.event}`;
    $('#logisticRoleChip').textContent = normalizedRoleLabel();
    logisticLocation = session.lokasi || '';
    renderLogisticLocations();
    renderLogisticCategories();
    renderLogisticProducts();
    renderLogisticCart();
    updateMetrics();
    refreshLogisticSummary(!offlineRestore && navigator.onLine);
    return;
  }

  currentMode = 'sales';
  $('#salesView').classList.remove('hidden');
  $('#userName').textContent = session.namaUser || session.username;
  $('#venueLabel').textContent = `${session.lokasi} • ${session.event}`;
  $$('.payment').forEach(btn => btn.classList.toggle('active', btn.dataset.value === 'Cash'));

  renderCategories();
  renderProducts();
  renderCart();
  renderQrisRequirement();
  renderPhotoVault();
  updateMetrics();
  refreshMySummary(!offlineRestore && navigator.onLine);
}

function normalizedRole() {
  return String(session?.role || '').trim().toLowerCase();
}

function isLogisticRole() {
  const role = normalizedRole();
  return role.includes('logistic') || role.includes('logistik') || role.includes('barmen') || role.includes('barman') || role.includes('bartender');
}

function isBarmenRole() {
  const role = normalizedRole();
  return role.includes('barmen') || role.includes('barman') || role.includes('bartender');
}

function normalizedRoleLabel() {
  if (isBarmenRole()) return 'BARMEN';
  if (isLogisticRole()) return 'LOGISTIC';
  return String(session?.role || 'SPG').toUpperCase();
}

async function restoreOrSync() {
  const token = await metaGet(TOKEN_KEY);
  if (!token) return;

  try {
    const oldMode = currentMode;
    const result = await KtdBridge.call('restoreSession', token);
    const cached = {token, ...result};
    await metaSet(SESSION_CACHE_KEY, cached);
    await metaSet(VENUE_CACHE_KEY, result.venues || venues);

    session = result.session;
    products = result.products || products;
    venues = result.venues || venues;
    const newMode = isLogisticRole() ? 'logistic' : 'sales';

    if (!session || oldMode !== newMode || currentMode === 'login') {
      enterApp(cached, false);
    } else if (newMode === 'logistic') {
      renderLogisticLocations();
      renderLogisticCategories();
      renderLogisticProducts();
      renderLogisticCart();
      await refreshLogisticSummary(false);
    } else {
      renderCategories();
      renderProducts();
      renderCart();
      renderPhotoVault();
    }
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    if (msg.includes('session') || msg.includes('tidak aktif') || msg.includes('berakhir')) {
      await metaDel(TOKEN_KEY);
      await metaDel(SESSION_CACHE_KEY);
      session = null;
      currentMode = 'login';
      showLogin();
    }
  }
}

async function logout() {
  const username = session?.username || '';
  const pendingTx = username ? await queueCountForUser(username) : 0;
  const pendingPhotos = username ? await photoPendingCountForUser(username) : 0;
  const pendingLogistic = username ? await logisticPendingCountForUser(username) : 0;

  if (pendingTx || pendingPhotos || pendingLogistic) {
    const ok = confirm(`Masih ada ${pendingTx} transaksi sales, ${pendingPhotos} foto, dan ${pendingLogistic} movement logistic menunggu sync. Logout? Data lokal tetap tersimpan di perangkat.`);
    if (!ok) return;
  }

  await metaDel(TOKEN_KEY);
  await metaDel(SESSION_CACHE_KEY);
  session = null;
  products = [];
  cart = {};
  logisticCart = {};
  currentMode = 'login';
  currentPhotoId = '';
  resetQrisPreview();
  $('#salesView').classList.add('hidden');
  $('#logisticsView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  renderVenueSelect();
}

function showLogin() {
  currentMode = 'login';
  $('#salesView').classList.add('hidden');
  $('#logisticsView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  metaGet(VENUE_CACHE_KEY).then(v => {
    venues = Array.isArray(v) && v.length ? v : STATIC_VENUES.slice();
    renderVenueSelect();
  });
}

function renderCategories() {
  const cats = ['ALL', ...new Set(products.map(p => p.subKategori || 'LAINNYA'))];
  $('#productTabs').innerHTML = cats.map(cat =>
    `<button class="category-tab ${cat === selectedCategory ? 'active' : ''}" data-cat="${esc(cat)}">${esc(cat === 'ALL' ? 'SEMUA' : cat)}</button>`
  ).join('');

  $$('.category-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategory = btn.dataset.cat;
      renderCategories();
      renderProducts();
    });
  });
}

function renderProducts() {
  const filtered = products.filter(p => selectedCategory === 'ALL' || String(p.subKategori) === selectedCategory);
  $('#productList').innerHTML = filtered.map(p => {
    const qty = Number(cart[p.kodeProduk] || 0);
    return `<div class="product-card ${qty ? 'in-cart' : ''}">
      <div><b>${esc(p.namaProduk)}</b><span class="price">${money(p.harga)} / ${esc(p.satuan)}</span></div>
      <div class="product-controls">
        <button type="button" data-action="minus" data-code="${esc(p.kodeProduk)}">−</button>
        <strong>${qty}</strong>
        <button type="button" class="plus" data-action="plus" data-code="${esc(p.kodeProduk)}">+</button>
      </div>
    </div>`;
  }).join('');

  $$('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => changeCart(btn.dataset.code, btn.dataset.action === 'plus' ? 1 : -1));
  });
}

function changeCart(code, delta) {
  const next = Math.max(0, Math.min(999, Number(cart[code] || 0) + delta));
  if (next === 0) delete cart[code]; else cart[code] = next;
  renderProducts();
  renderCart();
  if (navigator.vibrate) navigator.vibrate(12);
}

function renderCart() {
  const lines = selectedCartLines();
  const qty = lines.reduce((sum, p) => sum + Number(cart[p.kodeProduk] || 0), 0);
  const total = lines.reduce((sum, p) => sum + Number(cart[p.kodeProduk] || 0) * Number(p.harga || 0), 0);

  $('#cartInfo').textContent = lines.length ? `${lines.length} produk • ${qty} qty` : 'Belum ada item';
  $('#cartList').innerHTML = lines.length ? lines.map(p => {
    const q = Number(cart[p.kodeProduk] || 0);
    return `<div class="cart-row"><div><b>${esc(p.namaProduk)}</b><span>${q} × ${money(p.harga)}</span></div><strong>${money(q * Number(p.harga || 0))}</strong></div>`;
  }).join('') : '<div class="cart-empty">Pilih satu atau beberapa produk di atas.</div>';

  $('#total').textContent = money(total);
  $('#totalQty').textContent = `${qty} qty`;
}

function selectedCartLines() {
  return products.filter(p => Number(cart[p.kodeProduk] || 0) > 0);
}

function renderQrisRequirement() {
  const isQris = payment === 'QRIS';
  $('#qrisSection').classList.toggle('hidden', !isQris);
  if (isQris && !currentPhotoId) {
    setQrisStatus('QRIS wajib foto baru dari kamera perangkat sebelum transaksi disimpan.', false);
  }
}

async function handleQrisCapture(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const check = validateCameraFile(file);
  if (!check.ok) {
    setQrisStatus(check.error, true);
    return;
  }

  setQrisStatus('Mengamankan foto ke perangkat...', false);
  setButton('#qrisCameraBtn', true, 'MEMPROSES...');

  try {
    const compressed = await compressImage(file);
    const photoId = 'QRP-' + randomId8() + randomId8();
    const record = {
      photoId,
      orderId: '',
      ownerUsername: String(session?.username || '').toLowerCase(),
      username: session?.username || '',
      namaUser: session?.namaUser || session?.username || '',
      venue: session?.lokasi || '',
      event: session?.event || '',
      createdAt: new Date().toISOString(),
      clientTimestamp: Date.now(),
      state: 'DRAFT',
      uploadStatus: 'LOCAL',
      driveUrl: '',
      driveFileId: '',
      driveFileName: '',
      lastError: '',
      items: [],
      totalValue: 0,
      blob: compressed.blob,
      width: compressed.width,
      height: compressed.height,
      originalBytes: file.size,
      storedBytes: compressed.blob.size
    };

    await photoPut(record);
    currentPhotoId = photoId;
    showQrisPreview(record.blob);
    setQrisStatus(`Foto aman lokal • ${Math.round(record.storedBytes / 1024)} KB`, false, true);
    $('#qrisRetakeBtn').classList.remove('hidden');
    await renderPhotoVault();
  } catch (err) {
    setQrisStatus(err?.message || String(err), true);
  } finally {
    setButton('#qrisCameraBtn', false, 'AMBIL FOTO QRIS');
  }
}

function validateCameraFile(file) {
  if (!String(file.type || '').toLowerCase().startsWith('image/')) return {ok:false,error:'Bukti QRIS harus berupa foto.'};
  if (file.size > 20000000) return {ok:false,error:'Foto terlalu besar. Maksimal 20 MB.'};
  const modified = Number(file.lastModified || 0);
  if (modified && Math.abs(Date.now() - modified) > 20 * 60 * 1000) {
    return {ok:false,error:'Foto terlihat bukan foto baru. Ambil ulang menggunakan kamera perangkat.'};
  }
  return {ok:true};
}

async function compressImage(file) {
  const image = await loadImage(file);
  let srcW = image.width || image.naturalWidth;
  let srcH = image.height || image.naturalHeight;
  if (!srcW || !srcH) throw new Error('Foto tidak dapat dibaca.');

  let maxSide = 1280;
  let quality = 0.78;
  let result = null;

  for (let pass = 0; pass < 5; pass++) {
    const ratio = Math.min(1, maxSide / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * ratio));
    const height = Math.max(1, Math.round(srcH * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', {alpha:false, desynchronized:true});
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Kompresi foto gagal.')), 'image/jpeg', quality);
    });
    result = {blob, width, height};
    if (blob.size <= 750000) break;
    quality = Math.max(0.52, quality - 0.08);
    maxSide = Math.round(maxSide * 0.88);
  }

  if (image.close) try { image.close(); } catch (_) {}
  if (!result || result.blob.size > 1200000) throw new Error('Foto masih terlalu besar. Ambil ulang dengan resolusi normal.');
  return result;
}

async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch (_) {}
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Foto tidak dapat dibaca.'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function showQrisPreview(blob) {
  resetPreviewUrlOnly();
  currentPreviewUrl = URL.createObjectURL(blob);
  $('#qrisPreview').src = currentPreviewUrl;
  $('#qrisPreview').classList.remove('hidden');
}

function resetPreviewUrlOnly() {
  if (currentPreviewUrl) {
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = '';
  }
}

function resetQrisPreview() {
  resetPreviewUrlOnly();
  $('#qrisPreview').removeAttribute('src');
  $('#qrisPreview').classList.add('hidden');
  $('#qrisRetakeBtn').classList.add('hidden');
  $('#qrisCameraInput').value = '';
  setQrisStatus(payment === 'QRIS' ? 'Ambil foto bukti QRIS untuk transaksi berikutnya.' : '', false);
}

function setQrisStatus(text, isError = false, isSuccess = false) {
  const el = $('#qrisStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('success', !!isSuccess);
}

async function saveOrder() {
  if (!session) return;
  const lines = selectedCartLines();
  if (!lines.length) {
    showMsg('#saveMsg', 'Pilih minimal 1 item.', true);
    return;
  }

  let qrisPhoto = null;
  if (payment === 'QRIS') {
    if (!currentPhotoId) {
      showMsg('#saveMsg', 'QRIS wajib mengambil foto bukti pembayaran terlebih dahulu.', true);
      return;
    }
    qrisPhoto = await photoGet(currentPhotoId);
    if (!qrisPhoto?.blob) {
      showMsg('#saveMsg', 'Foto QRIS tidak ditemukan. Ambil ulang foto.', true);
      return;
    }
  }

  const now = Date.now();
  const orderId = randomId8();
  const deviceId = await metaGet(DEVICE_KEY);
  const note = $('#note').value.trim();
  const totalValue = lines.reduce((sum, p) => sum + Number(cart[p.kodeProduk] || 0) * Number(p.harga || 0), 0);

  const records = lines.map((p, index) => ({
    idTransaksi: randomId8(),
    idPesanan: orderId,
    clientTimestamp: now + index,
    kodeProduk: p.kodeProduk,
    namaProduk: p.namaProduk,
    subKategori: p.subKategori,
    satuan: p.satuan,
    harga: Number(p.harga || 0),
    qty: Number(cart[p.kodeProduk] || 0),
    metodePembayaran: payment,
    buktiPembayaran: '',
    keterangan: note,
    deviceId,
    ownerUsername: String(session.username || '').toLowerCase(),
    lokasi: session.lokasi,
    event: session.event,
    createdAt: now + index,
    syncStatus: 'PENDING',
    lastSyncError: ''
  }));

  await queuePutMany(records);

  if (payment === 'QRIS' && qrisPhoto) {
    qrisPhoto.orderId = orderId;
    qrisPhoto.clientTimestamp = now;
    qrisPhoto.state = 'COMMITTED';
    qrisPhoto.uploadStatus = 'PENDING';
    qrisPhoto.items = lines.map(p => ({kodeProduk:p.kodeProduk, qty:Number(cart[p.kodeProduk] || 0)}));
    qrisPhoto.totalValue = totalValue;
    qrisPhoto.updatedAt = new Date().toISOString();
    await photoPut(qrisPhoto);
  }

  cart = {};
  $('#note').value = '';
  renderProducts();
  renderCart();
  showMsg('#saveMsg', navigator.onLine ? 'Pesanan tersimpan lokal • sinkronisasi berjalan…' : 'Pesanan tersimpan OFFLINE di perangkat.', false);
  currentPhotoId = '';
  resetQrisPreview();

  await updateMetrics();
  await refreshMySummary(false);
  await renderPhotoVault();

  if (navigator.vibrate) navigator.vibrate([25,30,25]);
  if (navigator.onLine) setTimeout(syncAll, 250);
}

async function syncAll() {
  if (syncInProgress || !session || !navigator.onLine) return;
  syncInProgress = true;
  updateNetworkState(true);

  try {
    if (isLogisticRole()) {
      await syncLogisticQueue();
      await metaSet(LAST_SYNC_KEY, new Date().toISOString());
      await refreshLogisticSummary(true);
    } else {
      await syncQrisPhotos();
      await syncQueue();
      await metaSet(LAST_SYNC_KEY, new Date().toISOString());
      await refreshMySummary(true);
    }
  } catch (err) {
    console.warn('Sync tertunda:', err);
    if (isLogisticRole()) showMsg('#logisticSaveMsg', 'Sebagian sync logistic tertunda. Data lokal tetap aman.', true);
    else showMsg('#saveMsg', 'Sebagian sync tertunda. Data lokal tetap aman.', true);
  } finally {
    syncInProgress = false;
    updateNetworkState(false);
    await updateMetrics();
    if (!isLogisticRole()) await renderPhotoVault();
  }
}

async function syncQrisPhotos() {
  const token = await metaGet(TOKEN_KEY);
  if (!token || !session || !navigator.onLine) return;

  const all = await photoAll();
  const username = String(session.username || '').toLowerCase();
  const pending = all.filter(p =>
    String(p.ownerUsername || '').toLowerCase() === username &&
    p.state === 'COMMITTED' && p.orderId && p.uploadStatus !== 'UPLOADED'
  ).sort((a,b) => Number(a.clientTimestamp || 0) - Number(b.clientTimestamp || 0)).slice(0, 5);

  for (const photo of pending) {
    try {
      photo.uploadStatus = 'UPLOADING';
      photo.lastError = '';
      await photoPut(photo);

      const base64 = await blobToBase64(photo.blob);
      const result = await KtdBridge.call('uploadQrisPhoto', {
        token,
        orderId: photo.orderId,
        clientTimestamp: photo.clientTimestamp,
        items: photo.items || [],
        base64
      });

      photo.uploadStatus = 'UPLOADED';
      photo.driveUrl = result.url || '';
      photo.driveFileId = result.fileId || '';
      photo.driveFileName = result.fileName || '';
      photo.uploadedAt = new Date().toISOString();
      photo.lastError = '';
      await photoPut(photo);

      if (photo.driveUrl) await updateQueueProofByOrder(photo.orderId, photo.driveUrl);
    } catch (err) {
      photo.uploadStatus = 'ERROR';
      photo.lastError = String(err?.message || err);
      photo.lastAttemptAt = new Date().toISOString();
      await photoPut(photo);
    }
  }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength > 1300000) throw new Error('Foto QRIS terlalu besar untuk upload Drive.');
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function updateQueueProofByOrder(orderId, url) {
  const rows = await queueAll();
  const mine = rows.filter(r => r.idPesanan === orderId);
  if (!mine.length) return;
  mine.forEach(r => { r.buktiPembayaran = url; });
  await queuePutMany(mine);
}

async function syncQueue() {
  const token = await metaGet(TOKEN_KEY);
  if (!token || !session || !navigator.onLine) return;
  let totalSynced = 0;

  while (navigator.onLine) {
    const pending = await getPendingForUser(session.username, Number(window.KTD_CONFIG?.SYNC_BATCH_SIZE || 120));
    if (!pending.length) break;

    pending.forEach(row => {
      row.syncStatus = 'SYNCING';
      row.lastSyncAttempt = new Date().toISOString();
    });
    await queuePutMany(pending);

    let result;
    try {
      result = await KtdBridge.call('syncTransactions', {token, records:pending});
    } catch (err) {
      pending.forEach(row => {
        row.syncStatus = 'PENDING';
        row.lastSyncError = String(err?.message || err);
      });
      await queuePutMany(pending);
      throw err;
    }

    const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
    const rejectedMap = new Map((result.rejected || []).map(x => [x.idTransaksi, x.error]));

    for (const row of pending) {
      if (accepted.has(row.idTransaksi)) {
        await queueDelete(row.idTransaksi);
        totalSynced++;
      } else if (rejectedMap.has(row.idTransaksi)) {
        row.syncStatus = 'ERROR';
        row.lastSyncError = rejectedMap.get(row.idTransaksi) || 'Ditolak server.';
        await queuePut(row);
      } else {
        row.syncStatus = 'PENDING';
        row.lastSyncError = 'Server belum mengonfirmasi transaksi.';
        await queuePut(row);
      }
    }

    await new Promise(r => setTimeout(r, 80));
  }

  if (totalSynced) showMsg('#saveMsg', `${formatNumber(totalSynced)} transaksi berhasil disinkronkan.`, false);
}

async function refreshMySummary(forceNetwork = false) {
  if (!session || isLogisticRole()) return;
  const cacheKey = 'summary:' + String(session.username || '').toLowerCase();
  serverSummary = await metaGet(cacheKey) || serverSummary;
  const local = await getOfflineSummaryForUser(session.username);
  renderMySummary(mergeSummaries(serverSummary, local));

  if (forceNetwork && navigator.onLine) {
    try {
      const token = await metaGet(TOKEN_KEY);
      serverSummary = await KtdBridge.call('getMySalesSummary', token);
      await metaSet(cacheKey, serverSummary);
      const localNow = await getOfflineSummaryForUser(session.username);
      renderMySummary(mergeSummaries(serverSummary, localNow));
    } catch (_) {}
  }
}

function renderMySummary(merged) {
  $('#myTotalQty').textContent = formatNumber(merged.totalQty);
  $('#myTotalValue').textContent = money(merged.totalValue);
  $('#itemSummary').classList.toggle('empty-state', !merged.byItem.length);
  $('#itemSummary').innerHTML = merged.byItem.length ? merged.byItem.map(x =>
    `<div class="summary-row"><div><b>${esc(x.namaProduk || x.kodeProduk)}</b><small>${esc(x.kodeProduk || '')}${x.satuan ? ' • ' + esc(x.satuan) : ''}</small></div><div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div></div>`
  ).join('') : 'Belum ada penjualan.';

  $('#locationSummary').classList.toggle('empty-state', !merged.byLocation.length);
  $('#locationSummary').innerHTML = merged.byLocation.length ? merged.byLocation.map(x =>
    `<div class="summary-row"><div><b>${esc(x.lokasi)}</b><small>Penjualan akun ${esc(session.username)}</small></div><div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div></div>`
  ).join('') : 'Belum ada penjualan.';
}

function mergeSummaries(a, b) {
  const out = {totalQty:Number(a?.totalQty || 0)+Number(b?.totalQty || 0),totalValue:Number(a?.totalValue || 0)+Number(b?.totalValue || 0),byItem:[],byLocation:[]};
  const im = new Map();
  const lm = new Map();
  for (const x of [...(a?.byItem || []), ...(b?.byItem || [])]) {
    const key = x.kodeProduk || x.namaProduk;
    if (!im.has(key)) im.set(key, {kodeProduk:x.kodeProduk,namaProduk:x.namaProduk,satuan:x.satuan,qty:0,value:0});
    const z = im.get(key); z.qty += Number(x.qty || 0); z.value += Number(x.value || 0);
  }
  for (const x of [...(a?.byLocation || []), ...(b?.byLocation || [])]) {
    const key = x.lokasi || 'Tanpa Lokasi';
    if (!lm.has(key)) lm.set(key, {lokasi:key,qty:0,value:0});
    const z = lm.get(key); z.qty += Number(x.qty || 0); z.value += Number(x.value || 0);
  }
  out.byItem = [...im.values()].sort((x,y) => String(x.namaProduk).localeCompare(String(y.namaProduk)));
  out.byLocation = [...lm.values()].sort((x,y) => String(x.lokasi).localeCompare(String(y.lokasi)));
  return out;
}

async function getOfflineSummaryForUser(username) {
  const uname = String(username || '').toLowerCase();
  const rows = (await queueAll()).filter(x => String(x.ownerUsername || '').toLowerCase() === uname);
  const out = {totalQty:0,totalValue:0,byItem:[],byLocation:[]};
  const im = new Map();
  const lm = new Map();

  rows.forEach(x => {
    const qty = Number(x.qty || 0);
    const value = qty * Number(x.harga || 0);
    out.totalQty += qty;
    out.totalValue += value;
    const code = x.kodeProduk || '';
    if (!im.has(code)) im.set(code, {kodeProduk:code,namaProduk:x.namaProduk || code,satuan:x.satuan || '',qty:0,value:0});
    im.get(code).qty += qty;
    im.get(code).value += value;
    const loc = x.lokasi || 'Tanpa Lokasi';
    if (!lm.has(loc)) lm.set(loc, {lokasi:loc,qty:0,value:0});
    lm.get(loc).qty += qty;
    lm.get(loc).value += value;
  });

  out.byItem = [...im.values()];
  out.byLocation = [...lm.values()];
  return out;
}

async function renderPhotoVault() {
  if (!session || !$('#photoVaultList')) return;
  const username = String(session.username || '').toLowerCase();
  const rows = (await photoAll())
    .filter(p => String(p.ownerUsername || '').toLowerCase() === username)
    .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  $('#photoVaultCount').textContent = String(rows.length);
  const storage = await storageEstimate();
  $('#storageStatus').textContent = storage;

  if (!rows.length) {
    $('#photoVaultList').innerHTML = '<div class="empty-state">Belum ada foto QRIS lokal.</div>';
    return;
  }

  $('#photoVaultList').innerHTML = rows.map(p => {
    const status = p.uploadStatus === 'UPLOADED' ? 'DRIVE OK' : (p.state === 'DRAFT' ? 'DRAFT LOKAL' : 'MENUNGGU DRIVE');
    const name = p.driveFileName || (p.orderId ? 'Order ' + p.orderId : 'Foto belum terkait order');
    const size = p.blob ? Math.round(p.blob.size / 1024) : 0;
    return `<div class="vault-row" data-photo-id="${esc(p.photoId)}">
      <div class="vault-info"><b>${esc(name)}</b><span>${formatDateTime(p.createdAt)} • ${size} KB</span><small>${esc(status)}${p.lastError ? ' • ' + esc(p.lastError) : ''}</small></div>
      <div class="vault-actions"><button type="button" data-vault="view">LIHAT</button><button type="button" data-vault="save">SIMPAN DEVICE</button></div>
    </div>`;
  }).join('');

  $$('[data-vault]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const photoId = btn.closest('[data-photo-id]')?.dataset.photoId;
      const record = await photoGet(photoId);
      if (!record?.blob) return;
      if (btn.dataset.vault === 'view') previewVaultPhoto(record);
      else await savePhotoToDevice(record);
    });
  });
}

function previewVaultPhoto(record) {
  const url = URL.createObjectURL(record.blob);
  const win = window.open('', '_blank');
  if (!win) { URL.revokeObjectURL(url); return; }
  win.document.write(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>QRIS</title><style>body{margin:0;background:#111;display:grid;place-items:center;min-height:100vh}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${url}"></body></html>`);
  win.document.close();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function savePhotoToDevice(record) {
  const fileName = record.driveFileName || `QRIS_${record.orderId || record.photoId}.jpg`;
  const file = new File([record.blob], fileName, {type:'image/jpeg'});

  try {
    if (navigator.share && navigator.canShare && navigator.canShare({files:[file]})) {
      await navigator.share({files:[file], title:'Bukti QRIS'});
      return;
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.warn(err);
  }

  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}


/* =========================================================
   LOGISTIC / BARMEN MODULE
   ========================================================= */
const LOGISTIC_TYPE_META = {
  IN: {label:'STOCK MASUK', sign:1},
  OUT: {label:'STOCK KELUAR / TERPAKAI', sign:-1},
  RETURN_IN: {label:'RETUR MASUK', sign:1},
  DAMAGE: {label:'RUSAK / WASTE', sign:-1}
};

function renderLogisticLocations() {
  const select = $('#logisticLocation');
  const hint = $('#logisticLocationHint');
  const all = Array.from(new Map((venues || STATIC_VENUES).map(v => [v.lokasi, v])).values());
  select.innerHTML = all.map(v => `<option value="${esc(v.lokasi)}">${esc(v.lokasi)}</option>`).join('');

  if (!logisticLocation) logisticLocation = session?.lokasi || all[0]?.lokasi || '';
  select.value = logisticLocation;

  if (isBarmenRole()) {
    logisticLocation = session?.lokasi || logisticLocation;
    select.value = logisticLocation;
    select.disabled = true;
    select.classList.add('logistic-location-locked');
    hint.textContent = 'Barmen hanya dapat input stock untuk lokasi login sendiri.';
  } else {
    select.disabled = false;
    select.classList.remove('logistic-location-locked');
    hint.textContent = 'Role Logistic dapat memilih lokasi stock yang dikelola.';
  }
}

function renderLogisticCategories() {
  const cats = ['ALL', ...new Set(products.map(p => p.subKategori || 'LAINNYA'))];
  $('#logisticProductTabs').innerHTML = cats.map(cat =>
    `<button class="category-tab ${cat === logisticCategory ? 'active' : ''}" data-log-cat="${esc(cat)}">${esc(cat === 'ALL' ? 'SEMUA' : cat)}</button>`
  ).join('');

  $$('[data-log-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      logisticCategory = btn.dataset.logCat;
      renderLogisticCategories();
      renderLogisticProducts();
    });
  });
}

function renderLogisticProducts() {
  const filtered = products.filter(p => logisticCategory === 'ALL' || String(p.subKategori) === logisticCategory);
  $('#logisticProductList').innerHTML = filtered.map(p => {
    const qty = Number(logisticCart[p.kodeProduk] || 0);
    return `<div class="product-card ${qty ? 'in-cart' : ''}">
      <div><b>${esc(p.namaProduk)}</b><span class="price">${esc(p.kodeProduk)} • ${esc(p.satuan)}</span></div>
      <div class="product-controls">
        <button type="button" data-log-action="minus" data-code="${esc(p.kodeProduk)}">−</button>
        <strong>${qty}</strong>
        <button type="button" class="plus" data-log-action="plus" data-code="${esc(p.kodeProduk)}">+</button>
      </div>
    </div>`;
  }).join('');

  $$('[data-log-action]').forEach(btn => {
    btn.addEventListener('click', () => changeLogisticCart(btn.dataset.code, btn.dataset.logAction === 'plus' ? 1 : -1));
  });
}

function changeLogisticCart(code, delta) {
  const next = Math.max(0, Math.min(9999, Number(logisticCart[code] || 0) + delta));
  if (!next) delete logisticCart[code]; else logisticCart[code] = next;
  renderLogisticProducts();
  renderLogisticCart();
  if (navigator.vibrate) navigator.vibrate(10);
}

function logisticCartLines() {
  return products.filter(p => Number(logisticCart[p.kodeProduk] || 0) > 0);
}

function renderLogisticCart() {
  const lines = logisticCartLines();
  const qty = lines.reduce((sum, p) => sum + Number(logisticCart[p.kodeProduk] || 0), 0);
  const meta = LOGISTIC_TYPE_META[logisticType] || LOGISTIC_TYPE_META.IN;

  $('#logisticCartInfo').textContent = lines.length ? `${lines.length} produk • ${qty} qty` : 'Belum ada item';
  $('#logisticCartList').innerHTML = lines.length ? lines.map(p => {
    const q = Number(logisticCart[p.kodeProduk] || 0);
    return `<div class="cart-row"><div><b>${esc(p.namaProduk)}</b><span>${esc(p.kodeProduk)} • ${esc(p.satuan)}</span></div><strong>${q} qty</strong></div>`;
  }).join('') : '<div class="cart-empty">Pilih satu atau beberapa produk di atas.</div>';

  $('#logisticTotalQty').textContent = formatNumber(qty);
  $('#logisticTypeLabel').textContent = `${meta.sign > 0 ? '+' : '−'} ${meta.label}`;
}

async function saveLogisticMovement() {
  if (!session || !isLogisticRole()) return;
  const lines = logisticCartLines();
  if (!lines.length) {
    showMsg('#logisticSaveMsg', 'Pilih minimal 1 produk.', true);
    return;
  }

  const location = isBarmenRole() ? session.lokasi : ($('#logisticLocation').value || session.lokasi);
  if (!location) {
    showMsg('#logisticSaveMsg', 'Lokasi stock belum dipilih.', true);
    return;
  }

  const type = $('#logisticType').value || 'IN';
  if (!LOGISTIC_TYPE_META[type]) {
    showMsg('#logisticSaveMsg', 'Jenis aktivitas logistic tidak valid.', true);
    return;
  }

  const now = Date.now();
  const batchId = 'LB-' + randomId8();
  const deviceId = await metaGet(DEVICE_KEY);
  const note = $('#logisticNote').value.trim();

  const records = lines.map((p, index) => ({
    idLogistic: 'LG-' + randomId8(),
    batchId,
    clientTimestamp: now + index,
    event: session.event,
    lokasi: location,
    tipe: type,
    kodeProduk: p.kodeProduk,
    namaProduk: p.namaProduk,
    qty: Number(logisticCart[p.kodeProduk] || 0),
    satuan: p.satuan,
    ownerUsername: String(session.username || '').toLowerCase(),
    username: session.username,
    namaUser: session.namaUser || session.username,
    role: session.role || '',
    keterangan: note,
    deviceId,
    createdAt: now + index,
    syncStatus: 'PENDING',
    lastSyncError: ''
  }));

  await logisticPutMany(records);
  logisticCart = {};
  $('#logisticNote').value = '';
  renderLogisticProducts();
  renderLogisticCart();
  showMsg('#logisticSaveMsg', navigator.onLine ? 'Movement tersimpan lokal • sinkronisasi berjalan…' : 'Movement tersimpan OFFLINE di perangkat.', false);

  await updateMetrics();
  await refreshLogisticSummary(false);
  if (navigator.vibrate) navigator.vibrate([25,30,25]);
  if (navigator.onLine) setTimeout(syncAll, 250);
}

async function syncLogisticQueue() {
  const token = await metaGet(TOKEN_KEY);
  if (!token || !session || !isLogisticRole() || !navigator.onLine) return;
  let totalSynced = 0;

  while (navigator.onLine) {
    const pending = await getLogisticPendingForUser(session.username, Number(window.KTD_CONFIG?.SYNC_BATCH_SIZE || 120));
    if (!pending.length) break;

    pending.forEach(row => {
      row.syncStatus = 'SYNCING';
      row.lastSyncAttempt = new Date().toISOString();
    });
    await logisticPutMany(pending);

    let result;
    try {
      result = await KtdBridge.call('syncLogistics', {token, records:pending});
    } catch (err) {
      pending.forEach(row => {
        row.syncStatus = 'PENDING';
        row.lastSyncError = String(err?.message || err);
      });
      await logisticPutMany(pending);
      throw err;
    }

    const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
    const rejectedMap = new Map((result.rejected || []).map(x => [x.idLogistic, x.error]));

    for (const row of pending) {
      if (accepted.has(row.idLogistic)) {
        await logisticDelete(row.idLogistic);
        totalSynced++;
      } else if (rejectedMap.has(row.idLogistic)) {
        row.syncStatus = 'ERROR';
        row.lastSyncError = rejectedMap.get(row.idLogistic) || 'Ditolak server.';
        await logisticPut(row);
      } else {
        row.syncStatus = 'PENDING';
        row.lastSyncError = 'Server belum mengonfirmasi movement.';
        await logisticPut(row);
      }
    }
    await new Promise(r => setTimeout(r, 80));
  }

  if (totalSynced) showMsg('#logisticSaveMsg', `${formatNumber(totalSynced)} movement berhasil disinkronkan.`, false);
}

async function refreshLogisticSummary(forceNetwork = false) {
  if (!session || !isLogisticRole()) return;
  const location = isBarmenRole() ? session.lokasi : (logisticLocation || session.lokasi);
  logisticLocation = location;
  const cacheKey = `logisticSummary:${session.event}:${location}`;
  logisticServerSummary = await metaGet(cacheKey) || logisticServerSummary;
  const local = await getLocalLogisticSummary(location);
  renderLogisticSummary(mergeLogisticSummary(logisticServerSummary, local));

  if (forceNetwork && navigator.onLine) {
    try {
      const token = await metaGet(TOKEN_KEY);
      logisticServerSummary = await KtdBridge.call('getLogisticSummary', {token, location});
      await metaSet(cacheKey, logisticServerSummary);
      const localNow = await getLocalLogisticSummary(location);
      renderLogisticSummary(mergeLogisticSummary(logisticServerSummary, localNow));
    } catch (err) {
      console.warn('Logistic summary:', err);
    }
  }
}

async function getLocalLogisticSummary(location) {
  const username = String(session?.username || '').toLowerCase();
  const rows = (await logisticAll()).filter(r =>
    String(r.ownerUsername || '').toLowerCase() === username &&
    String(r.event || '') === String(session?.event || '') &&
    String(r.lokasi || '') === String(location || '') &&
    r.syncStatus !== 'ERROR'
  );

  const map = new Map();
  for (const p of products) map.set(p.kodeProduk, {kodeProduk:p.kodeProduk,namaProduk:p.namaProduk,satuan:p.satuan,stock:0});
  rows.forEach(r => {
    if (!map.has(r.kodeProduk)) map.set(r.kodeProduk, {kodeProduk:r.kodeProduk,namaProduk:r.namaProduk,satuan:r.satuan,stock:0});
    const meta = LOGISTIC_TYPE_META[r.tipe] || {sign:0};
    map.get(r.kodeProduk).stock += Number(r.qty || 0) * meta.sign;
  });

  const recent = rows.slice().sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 25).map(r => ({
    idLogistic:r.idLogistic,
    timestamp:r.createdAt,
    tipe:r.tipe,
    kodeProduk:r.kodeProduk,
    namaProduk:r.namaProduk,
    qty:Number(r.qty || 0),
    qtySigned:Number(r.qty || 0) * (LOGISTIC_TYPE_META[r.tipe]?.sign || 0),
    satuan:r.satuan,
    namaUser:r.namaUser || r.username,
    role:r.role || '',
    keterangan:r.keterangan || '',
    local:true
  }));

  return {location, stockByItem:[...map.values()], recent};
}

function mergeLogisticSummary(server, local) {
  const stockMap = new Map();
  products.forEach(p => stockMap.set(p.kodeProduk, {kodeProduk:p.kodeProduk,namaProduk:p.namaProduk,satuan:p.satuan,stock:0}));
  for (const source of [server?.stockByItem || [], local?.stockByItem || []]) {
    source.forEach(x => {
      const key = x.kodeProduk || x.namaProduk;
      if (!stockMap.has(key)) stockMap.set(key, {kodeProduk:x.kodeProduk,namaProduk:x.namaProduk,satuan:x.satuan,stock:0});
      stockMap.get(key).stock += Number(x.stock || 0);
    });
  }

  const recent = [...(local?.recent || []), ...(server?.recent || [])]
    .sort((a,b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 30);

  return {location:local?.location || server?.location || logisticLocation, stockByItem:[...stockMap.values()], recent};
}

function renderLogisticSummary(summary) {
  const location = summary?.location || logisticLocation || session?.lokasi || '';
  $('#logisticSummaryLocation').textContent = `${location} • ${session?.event || ''}`;
  const stock = (summary?.stockByItem || []).sort((a,b) => String(a.namaProduk).localeCompare(String(b.namaProduk)));
  const total = stock.reduce((sum, x) => sum + Number(x.stock || 0), 0);
  $('#logisticStockTotal').textContent = formatNumber(total);
  $('#logisticStockList').classList.toggle('empty-state', !stock.length);
  $('#logisticStockList').innerHTML = stock.length ? stock.map(x => {
    const cls = Number(x.stock) < 0 ? 'stock-negative' : (Number(x.stock) === 0 ? 'stock-zero' : '');
    return `<div class="summary-row"><div><b>${esc(x.namaProduk || x.kodeProduk)}</b><small>${esc(x.kodeProduk || '')} • ${esc(x.satuan || '')}</small></div><div class="numbers"><strong class="${cls}">${formatNumber(x.stock)} qty</strong></div></div>`;
  }).join('') : 'Belum ada pergerakan stock.';

  const recent = summary?.recent || [];
  $('#logisticRecentList').classList.toggle('empty-state', !recent.length);
  $('#logisticRecentList').innerHTML = recent.length ? recent.map(x => {
    const signed = Number(x.qtySigned || 0);
    const label = LOGISTIC_TYPE_META[x.tipe]?.label || x.tipe || '';
    return `<div class="logistic-history-row"><div><b>${esc(x.namaProduk || x.kodeProduk)}</b><span>${esc(label)} • ${esc(x.namaUser || '')}${x.local ? ' • LOCAL/PENDING' : ''}</span><small>${formatDateTime(x.timestamp)}${x.keterangan ? ' • ' + esc(x.keterangan) : ''}</small></div><div class="movement"><strong class="${signed >= 0 ? 'movement-positive' : 'movement-negative'}">${signed >= 0 ? '+' : ''}${formatNumber(signed)}</strong><span>${esc(x.satuan || '')}</span></div></div>`;
  }).join('') : 'Belum ada movement.';
}

async function updateMetrics() {
  if (!session) return;

  const off = await metaGet(OFFLINE_SINCE_KEY);
  const last = await metaGet(LAST_SYNC_KEY);

  if (isLogisticRole()) {
    const pending = await logisticPendingCountForUser(session.username);
    const errors = await logisticErrorCountForUser(session.username);
    const today = await logisticTodayCountForUser(session.username);
    $('#logisticPendingCount').textContent = String(pending);
    $('#logisticPendingChip').textContent = `${pending} PENDING`;
    $('#logisticErrorCount').textContent = String(errors);
    $('#logisticTodayCount').textContent = String(today);
    $('#logisticOfflineDuration').textContent = off ? formatDuration(Date.now() - new Date(off).getTime()) : '0m';
    $('#logisticLastSyncAt').textContent = last ? formatDateTime(last) : 'Belum pernah';
    return;
  }

  const pending = await queueCountForUser(session.username);
  const errors = await queueErrorCountForUser(session.username);
  const photos = await photoPendingCountForUser(session.username);
  $('#pendingCount').textContent = String(pending);
  $('#pendingChip').textContent = `${pending} PENDING`;
  $('#photoPendingCount').textContent = String(photos);
  $('#errorCount').textContent = String(errors);
  $('#offlineDuration').textContent = off ? formatDuration(Date.now() - new Date(off).getTime()) : '0m';
  $('#lastSyncAt').textContent = last ? formatDateTime(last) : 'Belum pernah';
}

function updateNetworkState(forceSyncing) {
  const online = navigator.onLine;
  $('#offlineBar').classList.toggle('hidden', online);
  const text = forceSyncing || syncInProgress ? 'SYNCING...' : (online ? 'ONLINE' : 'OFFLINE');
  if ($('#netStatus')) $('#netStatus').textContent = text;
  if ($('#logisticNetStatus')) $('#logisticNetStatus').textContent = text;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const idb = event.target.result;
      let q;
      if (!idb.objectStoreNames.contains(STORE_QUEUE)) {
        q = idb.createObjectStore(STORE_QUEUE, {keyPath:'idTransaksi'});
      } else {
        q = event.target.transaction.objectStore(STORE_QUEUE);
      }
      if (!q.indexNames.contains('createdAt')) q.createIndex('createdAt', 'createdAt', {unique:false});
      if (!q.indexNames.contains('ownerUsername')) q.createIndex('ownerUsername', 'ownerUsername', {unique:false});

      if (!idb.objectStoreNames.contains(STORE_META)) idb.createObjectStore(STORE_META, {keyPath:'key'});

      let p;
      if (!idb.objectStoreNames.contains(STORE_PHOTOS)) {
        p = idb.createObjectStore(STORE_PHOTOS, {keyPath:'photoId'});
      } else {
        p = event.target.transaction.objectStore(STORE_PHOTOS);
      }
      if (!p.indexNames.contains('ownerUsername')) p.createIndex('ownerUsername', 'ownerUsername', {unique:false});
      if (!p.indexNames.contains('orderId')) p.createIndex('orderId', 'orderId', {unique:false});
      if (!p.indexNames.contains('createdAt')) p.createIndex('createdAt', 'createdAt', {unique:false});

      let l;
      if (!idb.objectStoreNames.contains(STORE_LOGISTIC)) {
        l = idb.createObjectStore(STORE_LOGISTIC, {keyPath:'idLogistic'});
      } else {
        l = event.target.transaction.objectStore(STORE_LOGISTIC);
      }
      if (!l.indexNames.contains('ownerUsername')) l.createIndex('ownerUsername', 'ownerUsername', {unique:false});
      if (!l.indexNames.contains('createdAt')) l.createIndex('createdAt', 'createdAt', {unique:false});
      if (!l.indexNames.contains('lokasi')) l.createIndex('lokasi', 'lokasi', {unique:false});
    };
    req.onsuccess = () => {
      const opened = req.result;
      opened.onversionchange = () => {
        try { opened.close(); } catch (_) {}
      };
      resolve(opened);
    };
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB compatibility layer.
 * Supports both current inline-key stores and legacy out-of-line-key stores.
 */
function idbPutCompat(objectStore, value, fallbackKey) {
  if (objectStore.keyPath === null) {
    if (fallbackKey === undefined || fallbackKey === null || fallbackKey === '') {
      throw new Error('IndexedDB legacy store memerlukan key eksplisit.');
    }
    return objectStore.put(value, fallbackKey);
  }
  return objectStore.put(value);
}

function metaGet(key) {
  return reqP(store(STORE_META).get(key)).then(value => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'value')) {
      return value.value;
    }
    return value;
  });
}

function metaSet(key, value) {
  const s = store(STORE_META, 'readwrite');
  return reqP(idbPutCompat(s, {key, value}, key));
}

function metaDel(key) {
  return reqP(store(STORE_META, 'readwrite').delete(key));
}

function queuePut(row) {
  const s = store(STORE_QUEUE, 'readwrite');
  return reqP(idbPutCompat(s, row, row && row.idTransaksi));
}

function queueDelete(id) {
  return reqP(store(STORE_QUEUE, 'readwrite').delete(id));
}

function queueAll() {
  return reqP(store(STORE_QUEUE).getAll()).then(rows => rows || []);
}

function photoPut(row) {
  const s = store(STORE_PHOTOS, 'readwrite');
  return reqP(idbPutCompat(s, row, row && row.photoId));
}

function photoGet(id) {
  return reqP(store(STORE_PHOTOS).get(id));
}

function photoAll() {
  return reqP(store(STORE_PHOTOS).getAll()).then(rows => rows || []);
}

function logisticPut(row) {
  const s = store(STORE_LOGISTIC, 'readwrite');
  return reqP(idbPutCompat(s, row, row && row.idLogistic));
}

function logisticDelete(id) {
  return reqP(store(STORE_LOGISTIC, 'readwrite').delete(id));
}

function logisticAll() {
  return reqP(store(STORE_LOGISTIC).getAll()).then(rows => rows || []);
}

function logisticPutMany(rows) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGISTIC, 'readwrite');
    const s = tx.objectStore(STORE_LOGISTIC);
    try {
      rows.forEach(row => idbPutCompat(s, row, row && row.idLogistic));
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan queue logistic.'));
    tx.onabort = () => reject(tx.error || new Error('Penyimpanan logistic dibatalkan.'));
  });
}

async function getLogisticPendingForUser(username, limit) {
  const u = String(username || '').toLowerCase();
  return (await logisticAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus !== 'ERROR')
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)).slice(0, limit);
}

async function logisticPendingCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await logisticAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus !== 'ERROR').length;
}

async function logisticErrorCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await logisticAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus === 'ERROR').length;
}

async function logisticTodayCountForUser(username) {
  const u = String(username || '').toLowerCase();
  const start = new Date(); start.setHours(0,0,0,0);
  return (await logisticAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && Number(r.createdAt || 0) >= start.getTime()).length;
}

function queuePutMany(rows) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    const s = tx.objectStore(STORE_QUEUE);
    try {
      rows.forEach(row => {
        idbPutCompat(s, row, row && row.idTransaksi);
      });
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan queue lokal.'));
    tx.onabort = () => reject(tx.error || new Error('Penyimpanan queue lokal dibatalkan.'));
  });
}

async function getPendingForUser(username, limit) {
  const u = String(username || '').toLowerCase();
  const rows = await queueAll();
  return rows.filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus !== 'ERROR')
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(0, limit);
}

async function queueCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus !== 'ERROR').length;
}

async function queueErrorCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.syncStatus === 'ERROR').length;
}

async function photoPendingCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await photoAll()).filter(p => String(p.ownerUsername || '').toLowerCase() === u && p.state === 'COMMITTED' && p.uploadStatus !== 'UPLOADED').length;
}

async function migrateLegacyQueueOwner(cachedSession) {
  const owner = String(cachedSession?.username || '').toLowerCase();
  if (!owner) return;
  const all = await queueAll();
  const legacy = all.filter(x => !x.ownerUsername);
  if (!legacy.length) return;
  legacy.forEach(x => {
    x.ownerUsername = owner;
    x.lokasi = x.lokasi || cachedSession.lokasi || '';
    x.event = x.event || cachedSession.event || '';
    x.syncStatus = x.syncStatus || 'PENDING';
  });
  await queuePutMany(legacy);
}

async function ensureDeviceId() {
  let id = await metaGet(DEVICE_KEY);
  if (!id) {
    id = 'DEV-' + randomId8() + randomId8();
    await metaSet(DEVICE_KEY, id);
  }
  return id;
}

async function requestPersistentStorage() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (_) {}
}

async function storageEstimate() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    if (!est?.quota) return persisted ? 'Persistent storage aktif' : 'Storage browser aktif';
    return `${persisted ? 'Persistent' : 'Browser'} • ${(Number(est.usage || 0)/1048576).toFixed(1)} / ${(Number(est.quota || 0)/1048576).toFixed(0)} MB`;
  } catch (_) { return 'Storage browser aktif'; }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      try { await reg.update(); } catch (_) {}
    } catch (err) { console.warn('Service Worker:', err); }
  });
}

function setButton(selector, busy, label) {
  const btn = $(selector);
  btn.disabled = !!busy;
  btn.textContent = label;
}

function showMsg(selector, text, isError = false) {
  const el = $(selector);
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('success', !isError && !!text);
}

function randomId8() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0].toString(36) + a[1].toString(36)).replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase().padEnd(8, '0');
}

function money(value) { return 'Rp' + Number(value || 0).toLocaleString('id-ID'); }
function formatNumber(value) { return Number(value || 0).toLocaleString('id-ID'); }
function formatDateTime(value) {
  try { return new Date(value).toLocaleString('id-ID', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  catch (_) { return String(value || ''); }
}
function formatDuration(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}j ${m}m` : `${m}m`;
}
function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
