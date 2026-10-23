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
const LAST_MAP_KEY = 'lastKnownMap';

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
let logisticItems = [];
let venues = STATIC_VENUES.slice();
let payment = 'Cash';
let selectedCategory = 'ALL';
let cart = {};
let currentPhotoId = '';
let currentPreviewUrl = '';
let currentInterviewPhotoId = '';
let currentInterviewPhotoPreviewUrl = '';
let interviewTried = false;
let interviewWizardStep = 0;
let interviewWizardSections = [];
let interviewWizardNavReady = false;
let syncInProgress = false;
let serverSummary = {totalQty:0,totalValue:0,byItem:[],byLocation:[],byPayment:{Cash:{qty:0,value:0},QRIS:{qty:0,value:0}}};
let currentMode = 'login';
let logisticCart = {};
let logisticCategory = 'ALL';
let logisticType = 'IN';
let logisticLocation = '';
let logisticServerSummary = {location:'',stockByItem:[],recent:[],catalog:[]};

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
  $('#syncBtn').addEventListener('click', manualSyncButton);
  $('#pushPendingBtn').addEventListener('click', forcePushAllPending);
  $('#refreshSummaryBtn').addEventListener('click', () => refreshMySummary(true));
  $('#downloadAllQrisBtn').addEventListener('click', downloadAllQrisPhotos);
  $('#interviewSaveBtn').addEventListener('click', saveConsumerInterview);
  $('#interviewSyncBtn').addEventListener('click', manualSyncButton);
  $('#interviewRefreshBtn').addEventListener('click', refreshConsumerInterviewSummary);
  $('#interviewResetBtn').addEventListener('click', async () => { await discardInterviewDraftPhoto(); resetConsumerInterviewForm(); showMsg('#interviewSaveMsg', 'Form siap untuk interview berikutnya.', false); });
  $('#interviewTriedBtn').addEventListener('click', confirmInterviewTried);
  $('#interviewPhotoCameraBtn').addEventListener('click', () => { if (!$('#interviewPhotoConsent').checked) { setInterviewPhotoStatus('Centang persetujuan foto terlebih dahulu.', true); return; } const input=$('#interviewPhotoCameraInput'); input.value=''; input.click(); });
  $('#interviewPhotoCameraInput').addEventListener('change', handleInterviewPhotoCapture);
  $('#interviewPhotoRetakeBtn').addEventListener('click', () => { if (!$('#interviewPhotoConsent').checked) { setInterviewPhotoStatus('Centang persetujuan foto terlebih dahulu.', true); return; } const input=$('#interviewPhotoCameraInput'); input.value=''; input.click(); });
  $('#applySalesDateBtn').addEventListener('click', () => refreshSalesByDate(true));
  $('#todaySalesDateBtn').addEventListener('click', async () => { $('#salesDateFilter').value = jakartaDateKey(Date.now()); await refreshSalesByDate(true); });
  $('#salesDateFilter').addEventListener('change', () => refreshSalesByDate(true));
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
  $('#interviewLogoutBtn').addEventListener('click', logout);
  $('#logisticSaveBtn').addEventListener('click', saveLogisticMovement);
  $('#logisticSyncBtn').addEventListener('click', manualSyncButton);
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
  $$('#interviewView input[type=radio]').forEach(input => input.addEventListener('change', renderInterviewShiftPreview));
  setupInterviewWizard();
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
  logisticItems = result.logisticItems || [];
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
  $('#interviewView').classList.add('hidden');

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

  if (isTlRole()) {
    currentMode = 'interview';
    $('#interviewView').classList.remove('hidden');
    $('#interviewUserName').textContent = session.namaUser || session.username;
    $('#interviewVenueLabel').textContent = `${session.lokasi} • ${session.event}`;
    $('#interviewRoleChip').textContent = 'TL';
    ensureInterviewDate();
    resetConsumerInterviewForm();
    updateInterviewMetrics();
    refreshConsumerInterviewSummary();
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
  ensureSalesDateFilterDefault();
  updateMetrics();
  refreshMySummary(!offlineRestore && navigator.onLine);
  refreshSalesByDate(!offlineRestore && navigator.onLine);
}

function normalizedRole() {
  return String(session?.role || '').trim().toLowerCase();
}

function isTlRole() {
  const role = normalizedRole();
  return role === 'tl' || role.includes('team leader') || role.includes('teamleader');
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
    logisticItems = result.logisticItems || logisticItems;
    venues = result.venues || venues;
    const newMode = isLogisticRole() ? 'logistic' : (isTlRole() ? 'interview' : 'sales');

    if (!session || oldMode !== newMode || currentMode === 'login') {
      enterApp(cached, false);
    } else if (newMode === 'logistic') {
      renderLogisticLocations();
      renderLogisticCategories();
      renderLogisticProducts();
      renderLogisticCart();
      await refreshLogisticSummary(false);
    } else if (newMode === 'interview') {
      $('#interviewView').classList.remove('hidden');
      $('#interviewUserName').textContent = session.namaUser || session.username;
      $('#interviewVenueLabel').textContent = `${session.lokasi} • ${session.event}`;
      ensureInterviewDate();
      updateInterviewMetrics();
      await refreshConsumerInterviewSummary();
    } else {
      renderCategories();
      renderProducts();
      renderCart();
      renderPhotoVault();
      ensureSalesDateFilterDefault();
      await refreshSalesByDate(false);
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
  const pendingInterview = username ? await interviewPendingCountForUser(username) : 0;

  if (pendingTx || pendingPhotos || pendingLogistic || pendingInterview) {
    const ok = confirm(`Masih ada ${pendingTx} transaksi sales, ${pendingPhotos} foto, ${pendingLogistic} movement logistic, dan ${pendingInterview} interview konsumen menunggu sync. Logout? Data lokal tetap tersimpan di perangkat.`);
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
  $('#interviewView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  renderVenueSelect();
}

function showLogin() {
  currentMode = 'login';
  $('#salesView').classList.add('hidden');
  $('#logisticsView').classList.add('hidden');
  $('#interviewView').classList.add('hidden');
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
      recordType:'QRIS_PROOF',
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

function setInterviewPhotoStatus(text, isError=false, isSuccess=false){
  const el=$('#interviewPhotoStatus');
  if(!el)return;
  el.textContent=text||'';
  el.classList.toggle('error',!!isError);
  el.classList.toggle('success',!!isSuccess);
}

function resetInterviewPhotoPreview(){
  if(currentInterviewPhotoPreviewUrl){
    try{URL.revokeObjectURL(currentInterviewPhotoPreviewUrl);}catch(_){ }
    currentInterviewPhotoPreviewUrl='';
  }
  const img=$('#interviewPhotoPreview');
  if(img){img.removeAttribute('src');img.classList.add('hidden');}
  $('#interviewPhotoRetakeBtn')?.classList.add('hidden');
  setInterviewPhotoStatus('Foto konsumen wajib sebelum interview disimpan.',false);
}

async function handleInterviewPhotoCapture(event){
  const file=event.target.files&&event.target.files[0];
  if(!file)return;
  if(!interviewTried){setInterviewPhotoStatus('Ambil foto setelah konsumen sudah mencoba Peach Tea.',true);return;}
  if(!$('#interviewPhotoConsent').checked){setInterviewPhotoStatus('Centang persetujuan foto terlebih dahulu.',true);return;}
  if(!String(file.type||'').toLowerCase().startsWith('image/')){setInterviewPhotoStatus('Foto konsumen harus berupa foto.',true);return;}
  if(file.size>20000000){setInterviewPhotoStatus('Foto terlalu besar. Maksimal 20 MB.',true);return;}
  setInterviewPhotoStatus('Mengamankan foto ke perangkat...',false);
  setButton('#interviewPhotoCameraBtn',true,'MEMPROSES...');
  try{
    const compressed=await compressImage(file);
    await discardInterviewDraftPhoto();
    const photoId='CIP-'+randomId8()+randomId8();
    const record={
      photoId,recordType:'CONSUMER_INTERVIEW_PHOTO',interviewId:'',ownerUsername:String(session?.username||'').toLowerCase(),
      username:session?.username||'',namaUser:session?.namaUser||session?.username||'',venue:session?.lokasi||'',event:session?.event||'',
      createdAt:new Date().toISOString(),clientTimestamp:Date.now(),state:'DRAFT',uploadStatus:'LOCAL',driveUrl:'',driveFileId:'',driveFileName:'',lastError:'',
      ageGroup:$('#interviewAge').value||'',photoConsent:'YA',photoUsageConsent:selectedInterviewRadio('photoUsageConsent')||'TIDAK',
      blob:compressed.blob,width:compressed.width,height:compressed.height,originalBytes:file.size,storedBytes:compressed.blob.size
    };
    await photoPut(record);
    currentInterviewPhotoId=photoId;
    currentInterviewPhotoPreviewUrl=URL.createObjectURL(record.blob);
    $('#interviewPhotoPreview').src=currentInterviewPhotoPreviewUrl;
    $('#interviewPhotoPreview').classList.remove('hidden');
    $('#interviewPhotoRetakeBtn').classList.remove('hidden');
    setInterviewPhotoStatus(`Foto aman lokal • ${Math.round(record.storedBytes/1024)} KB`,false,true);
  }catch(err){setInterviewPhotoStatus(err?.message||String(err),true);}finally{
    setButton('#interviewPhotoCameraBtn',false,'AMBIL FOTO KONSUMEN');
  }
}

async function discardInterviewDraftPhoto(){
  if(!currentInterviewPhotoId)return;
  try{
    const row=await photoGet(currentInterviewPhotoId);
    if(row && row.recordType==='CONSUMER_INTERVIEW_PHOTO' && row.state==='DRAFT') await photoDelete(currentInterviewPhotoId);
  }catch(_){ }
  currentInterviewPhotoId='';
  resetInterviewPhotoPreview();
}

function confirmInterviewTried(){
  interviewTried=true;
  $('#interviewAfterSection').classList.remove('hidden');
  $('#interviewTriedBtn').disabled=true;
  $('#interviewTriedBtn').textContent='✓ KONSUMEN SUDAH MENCOBA';
  $('#interviewTriedStatus').textContent='Sudah mencoba • lanjutkan ke pertanyaan AFTER.';
  $('#interviewTriedStatus').classList.add('confirmed');
  const after=$('#interviewAfterSection');
  after?.scrollIntoView({behavior:'smooth',block:'start'});
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

  // ADD-ON V6.2: simpan Map bersama transaksi lokal.
  // Jika GPS belum tersedia, transaksi TETAP boleh disimpan; manual Sync/PUSH
  // akan mencoba melengkapi Map lagi tanpa menghapus record lama.
  const transactionMap = await resolveBestMap({allowFresh:true, timeoutMs:4500});

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
    map: transactionMap || '',
    mapCapturedAt: transactionMap ? new Date().toISOString() : '',
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
  showMsg('#saveMsg', navigator.onLine ? 'Pesanan tersimpan • sedang dikirim…' : 'Pesanan tersimpan di perangkat.', false);
  currentPhotoId = '';
  resetQrisPreview();

  await updateMetrics();
  await refreshMySummary(false);
  await renderPhotoVault();

  if (navigator.vibrate) navigator.vibrate([25,30,25]);
  if (navigator.onLine) setTimeout(syncAll, 250);
}

async function manualSyncButton() {
  if (!session) return;

  const logistic = isLogisticRole();
  const interview = isTlRole();
  const selector = logistic ? '#logisticSyncBtn' : (interview ? '#interviewSyncBtn' : '#syncBtn');
  const messageSelector = logistic ? '#logisticSaveMsg' : (interview ? '#interviewSaveMsg' : '#saveMsg');
  const idleLabel = 'SYNC DATA';

  if (!navigator.onLine) {
    showMsg(messageSelector, 'Tidak dapat Sync saat offline. Data lokal tetap aman.', true);
    return;
  }

  if (syncInProgress) {
    showMsg(messageSelector, 'SYNC sedang berjalan…', false);
    return;
  }

  const btn = $(selector);
  btn.classList.add('sync-loading');
  setButton(selector, true, 'SYNCING...');
  showMsg(messageSelector, logistic ? 'Mengirim data tersimpan…' : (interview ? 'Mengirim interview konsumen tersimpan…' : 'Mengirim data tersimpan dan mencadangkan bukti pembayaran…'), false);

  try {
    const result = await syncAll({manual:true, captureMap:true, allPhotos:true, allInterviewPhotos:true});
    if (result?.skipped) return;

    if (logistic) {
      showMsg(messageSelector, 'Sinkronisasi selesai.', false);
    } else if (interview) {
      showMsg(messageSelector, `Sinkronisasi selesai • ${formatNumber(result?.interviews?.totalSynced || 0)} interview • ${formatNumber(result?.interviewPhotos?.uploaded || 0)} foto tersimpan`, false);
      await updateInterviewMetrics();
      await refreshConsumerInterviewSummary();
    } else {
      const sales = result?.sales || {};
      const photos = result?.photos || {};
      const repair = result?.repair || {};
      showMsg(
        messageSelector,
        `Sinkronisasi selesai • ${formatNumber(sales.totalSynced || 0)} transaksi • ${formatNumber(photos.uploaded || 0)} bukti pembayaran dicadangkan`,
        false
      );
    }
  } catch (err) {
    showMsg(messageSelector, 'Pengiriman tertunda • data di perangkat tetap aman.', true);
  } finally {
    btn.classList.remove('sync-loading');
    setButton(selector, false, idleLabel);
  }
}

async function syncAll(options = {}) {
  if (syncInProgress || !session || !navigator.onLine) return {skipped:true};
  syncInProgress = true;
  updateNetworkState(true);

  let result = {skipped:false};

  try {
    if (isLogisticRole()) {
      result.logistic = await syncLogisticQueue();
      await metaSet(LAST_SYNC_KEY, new Date().toISOString());
      await refreshLogisticSummary(true);
    } else if (isTlRole()) {
      // Foto konsumen dikirim lebih dahulu. Jika interview belum ada di Sheet,
      // URL tetap disimpan di Vault dan akan dipatch setelah interview diterima.
      result.interviewPhotos = await syncConsumerInterviewPhotos({all: !!options.allInterviewPhotos});
      result.interviews = await syncInterviewQueue({silent: !!options.manual, retryErrors: !!options.manual});
      // Foto bisa sudah sukses ke Drive sebelum row interview masuk Sheet.
      // Repair link dilakukan terpisah tanpa meng-upload ulang foto.
      result.interviewPhotoRepair = await repairConsumerInterviewPhotoLinksFromVault({all: !!options.allInterviewPhotos});
      await metaSet(LAST_SYNC_KEY, new Date().toISOString());
      await updateInterviewMetrics();
      await refreshConsumerInterviewSummary();
    } else {
      // Existing pending dari versi lama mungkin belum punya Map.
      // Hanya manual Sync/PUSH yang meminta GPS baru agar auto-sync tidak
      // memunculkan permission prompt tanpa interaksi user.
      await enrichPendingMapsForUser(session.username, {
        allowFresh: !!options.captureMap
      });

      // Jika foto pernah sukses ke Drive tetapi queue belum sempat menerima URL,
      // pulihkan URL dari Vault lokal sebelum transaksi dikirim.
      await hydrateQueueProofUrlsFromVault();

      // Upload foto terlebih dahulu supaya URL Drive sudah tersedia di queue.
      result.photos = await syncQrisPhotos({all: !!options.allPhotos});
      await hydrateQueueProofUrlsFromVault();

      result.sales = await syncQueue({silent: !!options.manual});

      // Recovery untuk kasus foto sudah di Drive namun kolom Q pada Report Sales
      // masih kosong (mis. aplikasi tertutup di antara dua langkah sync).
      result.repair = await repairQrisProofLinksFromVault({all: !!options.allPhotos});

      await metaSet(LAST_SYNC_KEY, new Date().toISOString());
      await refreshMySummary(true);
      await refreshSalesByDate(true);
    }
  } catch (err) {
    console.warn('Sync tertunda:', err);
    if (isLogisticRole()) {
      showMsg('#logisticSaveMsg', 'Sebagian sync logistic tertunda. Data lokal tetap aman.', true);
    } else if (isTlRole()) {
      showMsg('#interviewSaveMsg', 'Sebagian interview belum terkirim. Data lokal tetap aman.', true);
    } else if (!options.manual) {
      showMsg('#saveMsg', 'Sebagian sync tertunda. Data lokal tetap aman.', true);
    }
    if (options.manual) throw err;
    result.error = String(err?.message || err);
  } finally {
    syncInProgress = false;
    updateNetworkState(false);
    await updateMetrics();
    if (!isLogisticRole() && !isTlRole()) await renderPhotoVault();
  }

  return result;
}

async function syncQrisPhotos(options = {}) {
  const token = await metaGet(TOKEN_KEY);
  if (!token || !session || !navigator.onLine) return {attempted:0,uploaded:0,failed:0};
  const all = await photoAll();
  const username = String(session.username || '').toLowerCase();
  const candidates = all.filter(p => (!p.recordType || p.recordType === 'QRIS_PROOF') && String(p.ownerUsername || '').toLowerCase() === username && p.state === 'COMMITTED' && p.orderId && p.uploadStatus !== 'UPLOADED')
    .sort((a,b) => Number(a.clientTimestamp || 0) - Number(b.clientTimestamp || 0));
  const pending = options.all ? candidates : candidates.slice(0,5);
  let uploaded=0, failed=0;
  for (const photo of pending) {
    try {
      photo.uploadStatus='UPLOADING'; photo.lastError=''; photo.lastAttemptAt=new Date().toISOString(); await photoPut(photo);
      const base64=await blobToBase64(photo.blob);
      const result=await KtdBridge.call('uploadQrisPhoto',{token,orderId:photo.orderId,clientTimestamp:photo.clientTimestamp,items:photo.items||[],base64});
      photo.uploadStatus='UPLOADED'; photo.driveUrl=result.url||''; photo.driveFileId=result.fileId||''; photo.driveFileName=result.fileName||''; photo.uploadedAt=new Date().toISOString(); photo.lastError=''; await photoPut(photo);
      if(photo.driveUrl) await updateQueueProofByOrder(photo.orderId,photo.driveUrl);
      uploaded++;
    } catch(err) {
      photo.uploadStatus='ERROR'; photo.lastError=String(err?.message||err); photo.lastAttemptAt=new Date().toISOString(); await photoPut(photo); failed++;
    }
  }
  return {attempted:pending.length,uploaded,failed};
}

async function syncConsumerInterviewPhotos(options={}){
  const token=await metaGet(TOKEN_KEY);
  if(!token||!session||!navigator.onLine||!isTlRole()) return {attempted:0,uploaded:0,failed:0};
  const all=await photoAll();
  const username=String(session.username||'').toLowerCase();
  const candidates=all.filter(p=>p.recordType==='CONSUMER_INTERVIEW_PHOTO'&&String(p.ownerUsername||'').toLowerCase()===username&&p.state==='COMMITTED'&&p.interviewId&&p.uploadStatus!=='UPLOADED').sort((a,b)=>Number(a.clientTimestamp||0)-Number(b.clientTimestamp||0));
  const pending=options.all?candidates:candidates.slice(0,5);
  let uploaded=0,failed=0;
  for(const photo of pending){
    try{
      photo.uploadStatus='UPLOADING';photo.lastError='';photo.lastAttemptAt=new Date().toISOString();await photoPut(photo);
      const base64=await blobToBase64(photo.blob);
      const result=await KtdBridge.call('uploadConsumerInterviewPhoto',{token,interviewId:photo.interviewId,clientTimestamp:photo.clientTimestamp,ageGroup:photo.ageGroup||'',photoConsent:'YA',photoUsageConsent:photo.photoUsageConsent||'TIDAK',base64});
      photo.uploadStatus='UPLOADED';photo.driveUrl=result.url||photo.driveUrl||'';photo.driveFileId=result.fileId||photo.driveFileId||'';photo.driveFileName=result.fileName||photo.driveFileName||'';photo.uploadedAt=new Date().toISOString();photo.lastError='';await photoPut(photo);uploaded++;
    }catch(err){photo.uploadStatus='ERROR';photo.lastError=String(err?.message||err);photo.lastAttemptAt=new Date().toISOString();await photoPut(photo);failed++;}
  }
  // Jika foto sudah ada di Drive tetapi interview baru saja masuk Sheet, endpoint upload
  // dipanggil ulang hanya untuk yang masih punya blob; duplicate filename aman/idempotent.
  return {attempted:pending.length,uploaded,failed};
}

async function repairConsumerInterviewPhotoLinksFromVault(options={}){
  if(!session||!navigator.onLine||!isTlRole())return {requested:0,patched:0};
  const user=String(session.username||'').toLowerCase();
  const photos=(await photoAll()).filter(p=>p.recordType==='CONSUMER_INTERVIEW_PHOTO'&&String(p.ownerUsername||'').toLowerCase()===user&&p.interviewId&&p.driveUrl).sort((a,b)=>Number(a.clientTimestamp||0)-Number(b.clientTimestamp||0));
  const selected=options.all?photos:photos.slice(-50);
  if(!selected.length)return {requested:0,patched:0};
  const token=await metaGet(TOKEN_KEY);
  const links=selected.map(p=>({interviewId:p.interviewId,url:p.driveUrl,fileId:p.driveFileId||'',fileName:p.driveFileName||''}));
  return await KtdBridge.call('repairConsumerInterviewPhotoLinks',{token,links});
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength > 1300000) throw new Error('Foto terlalu besar untuk upload Drive.');
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


/**
 * Salin kembali URL Drive dari Vault ke queue lokal jika transaksi pending
 * masih memiliki Bukti Pembayaran kosong.
 */
async function hydrateQueueProofUrlsFromVault() {
  if (!session) return 0;

  const username = String(session.username || '').toLowerCase();
  const photos = (await photoAll()).filter(p =>
    String(p.ownerUsername || '').toLowerCase() === username &&
    p.orderId &&
    p.driveUrl
  );

  if (!photos.length) return 0;

  const proofByOrder = new Map();
  photos.forEach(p => proofByOrder.set(String(p.orderId || '').toUpperCase(), String(p.driveUrl || '')));

  const rows = await queueAll();
  const changed = [];

  rows.forEach(row => {
    if (String(row.ownerUsername || '').toLowerCase() !== username) return;
    if (String(row.metodePembayaran || '').toUpperCase() !== 'QRIS') return;
    const url = proofByOrder.get(String(row.idPesanan || '').toUpperCase());
    if (!url || row.buktiPembayaran === url) return;
    row.buktiPembayaran = url;
    changed.push(row);
  });

  if (changed.length) await queuePutMany(changed);
  return changed.length;
}

/**
 * Repair kolom Q Report Sales dari URL Drive yang masih tersimpan di Vault.
 * Tidak meng-upload ulang foto dan tidak menghapus Vault lokal.
 */
async function repairQrisProofLinksFromVault(options = {}) {
  if (!session || !navigator.onLine || isLogisticRole()) return {requested:0,patched:0};

  const username = String(session.username || '').toLowerCase();
  const photos = (await photoAll())
    .filter(p =>
      (!p.recordType || p.recordType === 'QRIS_PROOF') &&
      String(p.ownerUsername || '').toLowerCase() === username &&
      p.orderId &&
      p.driveUrl
    )
    .sort((a,b) => Number(a.clientTimestamp || 0) - Number(b.clientTimestamp || 0));

  const selected = options.all ? photos : photos.slice(-25);
  if (!selected.length) return {requested:0,patched:0};

  const unique = new Map();
  selected.forEach(p => unique.set(String(p.orderId || '').toUpperCase(), String(p.driveUrl || '')));

  const token = await metaGet(TOKEN_KEY);
  const links = [...unique.entries()].map(([orderId, url]) => ({orderId, url}));

  return await KtdBridge.call('repairQrisProofLinks', {token, links});
}

/**
 * Google Maps URL dari GPS perangkat.
 * Penyimpanan LAST_MAP_KEY memakai META store yang sudah ada; tidak membuat
 * IndexedDB store/version baru.
 */
async function resolveBestMap(options = {}) {
  let cached = '';
  try { cached = String(await metaGet(LAST_MAP_KEY) || ''); } catch (_) {}

  const sessionMap = String(session?.map || '');
  const fallback = cached || sessionMap || '';
  if (!options.allowFresh || !navigator.geolocation) return fallback;

  const timeoutMs = Math.max(1500, Number(options.timeoutMs || 6000));

  return await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value || fallback);
    };

    navigator.geolocation.getCurrentPosition(
      async position => {
        const lat = Number(position?.coords?.latitude);
        const lng = Number(position?.coords?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          finish(fallback);
          return;
        }

        const url = `https://www.google.com/maps?q=${lat.toFixed(7)},${lng.toFixed(7)}`;
        try {
          await metaSet(LAST_MAP_KEY, url);
          if (session) session.map = url;
        } catch (_) {}
        finish(url);
      },
      () => finish(fallback),
      {
        enableHighAccuracy: true,
        maximumAge: 300000,
        timeout: timeoutMs
      }
    );
  });
}

async function enrichPendingMapsForUser(username, options = {}) {
  const uname = String(username || '').toLowerCase();
  const rows = (await queueAll()).filter(row =>
    String(row.ownerUsername || '').toLowerCase() === uname &&
    !String(row.map || '').trim()
  );

  if (!rows.length) return 0;

  const mapUrl = await resolveBestMap({
    allowFresh: !!options.allowFresh,
    timeoutMs: 6000
  });

  if (!mapUrl) return 0;

  const now = new Date().toISOString();
  rows.forEach(row => {
    row.map = mapUrl;
    row.mapCapturedAt = row.mapCapturedAt || now;
  });

  await queuePutMany(rows);
  return rows.length;
}

async function syncQueue(options = {}) {
  const token=await metaGet(TOKEN_KEY);
  if(!token || !session || !navigator.onLine) return {totalSynced:0,pendingRemaining:session?await queueCountForUser(session.username):0,errorRemaining:session?await queueErrorCountForUser(session.username):0};
  if(options.retryErrors) await resetSalesErrorsForUser(session.username);
  let totalSynced=0;
  while(navigator.onLine){
    const pending=await getPendingForUser(session.username,Number(window.KTD_CONFIG?.SYNC_BATCH_SIZE||120));
    if(!pending.length) break;
    pending.forEach(row=>{row.syncStatus='SYNCING';row.lastSyncAttempt=new Date().toISOString();});
    await queuePutMany(pending);
    let result;
    try{ result=await KtdBridge.call('syncTransactions',{token,records:pending}); }
    catch(err){ pending.forEach(row=>{row.syncStatus='PENDING';row.lastSyncError=String(err?.message||err);}); await queuePutMany(pending); throw err; }
    const accepted=new Set([...(result.accepted||[]),...(result.duplicates||[])]);
    const rejectedMap=new Map((result.rejected||[]).map(x=>[x.idTransaksi,x.error]));
    for(const row of pending){
      if(accepted.has(row.idTransaksi)){ await queueDelete(row.idTransaksi); totalSynced++; }
      else if(rejectedMap.has(row.idTransaksi)){ row.syncStatus='ERROR'; row.lastSyncError=rejectedMap.get(row.idTransaksi)||'Ditolak server.'; await queuePut(row); }
      else { row.syncStatus='PENDING'; row.lastSyncError='Server belum mengonfirmasi transaksi.'; await queuePut(row); }
    }
    await new Promise(r=>setTimeout(r,80));
  }
  const pendingRemaining=await queueCountForUser(session.username), errorRemaining=await queueErrorCountForUser(session.username);
  if(totalSynced && !options.silent) showMsg('#saveMsg',`${formatNumber(totalSynced)} transaksi berhasil disinkronkan.`,false);
  return {totalSynced,pendingRemaining,errorRemaining};
}

async function resetSalesErrorsForUser(username){
  const u=String(username||'').toLowerCase(), rows=await queueAll();
  const mine=rows.filter(r=>String(r.ownerUsername||'').toLowerCase()===u && r.syncStatus==='ERROR');
  mine.forEach(r=>{r.syncStatus='PENDING';r.forceRetryAt=new Date().toISOString();if(r.lastSyncError&&!r.previousSyncError)r.previousSyncError=r.lastSyncError;r.lastSyncError='';});
  if(mine.length) await queuePutMany(mine);
  return mine.length;
}

async function forcePushAllPending(){
  if(!session || isLogisticRole() || isTlRole()) return;
  if(!navigator.onLine){showMsg('#saveMsg','Tidak bisa mengirim saat offline. Data tetap aman di perangkat.',true);return;}
  if(syncInProgress){showMsg('#saveMsg','Sinkronisasi sedang berjalan. Tunggu sampai selesai lalu coba lagi.',true);return;}

  syncInProgress=true;
  updateNetworkState(true);
  const pushBtn = $('#pushPendingBtn');
  pushBtn.classList.add('sync-loading');
  setButton('#pushPendingBtn',true,'MENGIRIM DATA...');

  try{
    const beforePending=await queueCountForUser(session.username), beforeErrors=await queueErrorCountForUser(session.username);

    // Lengkapi Map untuk pending lama bila GPS tersedia.
    await enrichPendingMapsForUser(session.username,{allowFresh:true});

    // Penting: foto QRIS dikirim lebih dahulu agar URL Drive bisa ikut masuk
    // bersama transaksi yang masih pending.
    const photos=await syncQrisPhotos({all:true});
    await hydrateQueueProofUrlsFromVault();

    const sales=await syncQueue({retryErrors:true,silent:true});

    // Repair link untuk transaksi yang sudah telanjur ada di Report Sales.
    const repair=await repairQrisProofLinksFromVault({all:true});

    await metaSet(LAST_SYNC_KEY,new Date().toISOString());
    await refreshMySummary(true);
    await refreshSalesByDate(true);
    await updateMetrics();
    await renderPhotoVault();

    const afterPending=await queueCountForUser(session.username), afterErrors=await queueErrorCountForUser(session.username);
    if(afterPending===0 && afterErrors===0){
      showMsg('#saveMsg',`Pengiriman selesai • ${formatNumber(sales.totalSynced)} transaksi${photos.uploaded?` • ${formatNumber(photos.uploaded)} bukti pembayaran dicadangkan`:''}`,false);
    }else{
      showMsg('#saveMsg',`Pengiriman selesai sebagian • berhasil ${formatNumber(sales.totalSynced)} • tersisa ${formatNumber(afterPending)} data menunggu + ${formatNumber(afterErrors)} perlu dikirim ulang. Data yang belum terkirim tetap tersimpan di perangkat.`,true);
    }
  }catch(err){
    showMsg('#saveMsg','Pengiriman tertunda. Data di perangkat tidak dihapus.',true);
  } finally {
    syncInProgress=false;
    updateNetworkState(false);
    pushBtn.classList.remove('sync-loading');
    setButton('#pushPendingBtn',false,'KIRIM DATA TERTUNDA');
    await updateMetrics();
  }
}

async function refreshMySummary(forceNetwork = false) {
  if (!session || isLogisticRole()) return;
  const cacheKey = 'summary:v2:' + String(session.username || '').toLowerCase();
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

function renderMySummary(merged){
  const cash=merged?.byPayment?.Cash||{qty:0,value:0}, qris=merged?.byPayment?.QRIS||{qty:0,value:0};
  $('#myTotalQty').textContent=formatNumber(merged.totalQty); $('#myTotalValue').textContent=money(merged.totalValue);
  $('#myCashValue').textContent=money(cash.value); $('#myQrisValue').textContent=money(qris.value);
  $('#itemSummary').classList.toggle('empty-state',!merged.byItem.length);
  $('#itemSummary').innerHTML=merged.byItem.length?merged.byItem.map(x=>`<div class="summary-row"><div><b>${esc(x.namaProduk||x.kodeProduk)}</b><small>${esc(x.kodeProduk||'')}${x.satuan?' • '+esc(x.satuan):''}</small></div><div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div></div>`).join(''):'Belum ada penjualan.';
  $('#locationSummary').classList.toggle('empty-state',!merged.byLocation.length);
  $('#locationSummary').innerHTML=merged.byLocation.length?merged.byLocation.map(x=>`<div class="summary-row"><div><b>${esc(x.lokasi)}</b><small>Penjualan akun ${esc(session.username)}</small></div><div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div></div>`).join(''):'Belum ada penjualan.';
}
function normalizePaymentSummary(s){return {Cash:{qty:Number(s?.byPayment?.Cash?.qty||0),value:Number(s?.byPayment?.Cash?.value||0)},QRIS:{qty:Number(s?.byPayment?.QRIS?.qty||0),value:Number(s?.byPayment?.QRIS?.value||0)}};}
function mergeSummaries(a,b){
  const pa=normalizePaymentSummary(a),pb=normalizePaymentSummary(b);
  const out={totalQty:Number(a?.totalQty||0)+Number(b?.totalQty||0),totalValue:Number(a?.totalValue||0)+Number(b?.totalValue||0),byItem:[],byLocation:[],byPayment:{Cash:{qty:pa.Cash.qty+pb.Cash.qty,value:pa.Cash.value+pb.Cash.value},QRIS:{qty:pa.QRIS.qty+pb.QRIS.qty,value:pa.QRIS.value+pb.QRIS.value}}};
  const im=new Map(),lm=new Map();
  for(const x of [...(a?.byItem||[]),...(b?.byItem||[])]){const k=x.kodeProduk||x.namaProduk;if(!im.has(k))im.set(k,{kodeProduk:x.kodeProduk,namaProduk:x.namaProduk,satuan:x.satuan,qty:0,value:0});const z=im.get(k);z.qty+=Number(x.qty||0);z.value+=Number(x.value||0);}
  for(const x of [...(a?.byLocation||[]),...(b?.byLocation||[])]){const k=x.lokasi||'Tanpa Lokasi';if(!lm.has(k))lm.set(k,{lokasi:k,qty:0,value:0});const z=lm.get(k);z.qty+=Number(x.qty||0);z.value+=Number(x.value||0);}
  out.byItem=[...im.values()].sort((x,y)=>String(x.namaProduk).localeCompare(String(y.namaProduk)));out.byLocation=[...lm.values()].sort((x,y)=>String(x.lokasi).localeCompare(String(y.lokasi)));return out;
}
async function getOfflineSummaryForUser(username){
  const u=String(username||'').toLowerCase(),rows=(await queueAll()).filter(x=>String(x.ownerUsername||'').toLowerCase()===u);
  const out={totalQty:0,totalValue:0,byItem:[],byLocation:[],byPayment:{Cash:{qty:0,value:0},QRIS:{qty:0,value:0}}},im=new Map(),lm=new Map();
  rows.forEach(x=>{const qty=Number(x.qty||0),p=products.find(p=>String(p.kodeProduk||'')===String(x.kodeProduk||'')),price=Number(x.harga??p?.harga??0),value=qty*price;out.totalQty+=qty;out.totalValue+=value;const method=String(x.metodePembayaran||'').toUpperCase()==='QRIS'?'QRIS':'Cash';out.byPayment[method].qty+=qty;out.byPayment[method].value+=value;const code=x.kodeProduk||'';if(!im.has(code))im.set(code,{kodeProduk:code,namaProduk:x.namaProduk||p?.namaProduk||code,satuan:x.satuan||p?.satuan||'',qty:0,value:0});im.get(code).qty+=qty;im.get(code).value+=value;const loc=x.lokasi||'Tanpa Lokasi';if(!lm.has(loc))lm.set(loc,{lokasi:loc,qty:0,value:0});lm.get(loc).qty+=qty;lm.get(loc).value+=value;});
  out.byItem=[...im.values()];out.byLocation=[...lm.values()];return out;
}

async function renderPhotoVault() {
  if (!session || !$('#photoVaultList')) return;
  const username = String(session.username || '').toLowerCase();
  const rows = (await photoAll())
    .filter(p => (!p.recordType || p.recordType === 'QRIS_PROOF') && String(p.ownerUsername || '').toLowerCase() === username)
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
   ADD-ON V6.1 — DOWNLOAD SEMUA FOTO QRIS
   ========================================================= */
async function downloadAllQrisPhotos(){
  if(!session||isLogisticRole())return;
  const user=String(session.username||'').toLowerCase();
  const rows=(await photoAll()).filter(p=>(!p.recordType||p.recordType==='QRIS_PROOF')&&String(p.ownerUsername||'').toLowerCase()===user&&p.blob)
    .sort((a,b)=>Number(a.clientTimestamp||0)-Number(b.clientTimestamp||0));
  if(!rows.length){showMsg('#saveMsg','Tidak ada foto QRIS lokal di HP ini.',true);return;}
  setButton('#downloadAllQrisBtn',true,`MENYIAPKAN ${rows.length} FOTO...`);
  try{
    const used=new Set(),entries=[];
    rows.forEach((r,i)=>{let name=uniqueZipFileName(makeLocalQrisExportName(r,i+1),used);entries.push({name,blob:r.blob,date:r.createdAt?new Date(r.createdAt):new Date(Number(r.clientTimestamp||Date.now()))});});
    const manifest=[['No','File','Photo ID','Order ID','SPG','Waktu','Nominal','Status Drive','Drive URL']];
    rows.forEach((r,i)=>manifest.push([String(i+1),entries[i].name,String(r.photoId||''),String(r.orderId||''),String(r.namaUser||r.username||session.namaUser||session.username||''),String(r.createdAt||''),String(r.totalValue||0),String(r.uploadStatus||''),String(r.driveUrl||'')]));
    const csv='\uFEFF'+manifest.map(row=>row.map(csvCell).join(',')).join('\r\n');
    entries.push({name:'manifest.csv',blob:new Blob([csv],{type:'text/csv;charset=utf-8'}),date:new Date()});
    const zip=await createStoredZip(entries);
    const file=`QRIS_ALL_${safeFilePart(session.namaUser||session.username)}_${jakartaDateKey(Date.now()).replaceAll('-','')}_${rows.length}FOTO.zip`;
    await downloadBlobToDevice(zip,file);
    showMsg('#saveMsg',`${formatNumber(rows.length)} foto QRIS disiapkan dalam ${file}. Foto asli di Vault TIDAK dihapus.`,false);
  }catch(err){
    showMsg('#saveMsg','Download semua foto gagal • '+String(err?.message||err)+' • foto lokal tetap aman.',true);
  }finally{
    setButton('#downloadAllQrisBtn',false,'DOWNLOAD SEMUA FOTO QRIS (.ZIP)');
  }
}
function makeLocalQrisExportName(r,n){
  if(r.driveFileName)return sanitizeZipFileName(r.driveFileName);
  const spg=safeFilePart(r.namaUser||r.username||session?.namaUser||session?.username||'SPG');
  const names=(r.items||[]).map(x=>{const p=products.find(p=>String(p.kodeProduk||'')===String(x.kodeProduk||''));return safeFilePart(p?.namaProduk||x.kodeProduk||'Produk');}).filter(Boolean);
  const product=names.length?names.slice(0,2).join('+')+(names.length>2?`+${names.length-2}ITEM`:''):'QRIS';
  const nominal='Rp'+Math.round(Number(r.totalValue||0));
  const d=r.createdAt?new Date(r.createdAt):new Date(Number(r.clientTimestamp||Date.now()));
  return sanitizeZipFileName(`${spg}__${product}__${nominal}__${jakartaTimeKey(d)}__${safeFilePart(r.orderId||r.photoId||n)}.jpg`);
}
function safeFilePart(v){return String(v||'').trim().replace(/[\\/:*?"<>|#%{}\[\]~]+/g,'-').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-+|-+$/g,'').slice(0,65)||'NA';}
function sanitizeZipFileName(v){let s=String(v||'QRIS.jpg').replace(/[\\:*?"<>|]+/g,'-').replace(/^\/+/, '').slice(0,180);return /\.jpe?g$/i.test(s)?s:s+'.jpg';}
function uniqueZipFileName(name,used){let c=name,n=2;while(used.has(c)){c=name.replace(/(\.[^.]+)$/,`_${n}$1`);n++;}used.add(c);return c;}
function csvCell(v){return '"'+String(v??'').replaceAll('"','""')+'"';}

/* ZIP STORE builder: JPEG tidak dikompres ulang. */
async function createStoredZip(entries){
  const chunks=[],central=[],enc=new TextEncoder();let offset=0;
  for(const e of entries){
    const nb=enc.encode(String(e.name)),size=Number(e.blob.size||0),crc=crc32(new Uint8Array(await e.blob.arrayBuffer())),dos=zipDosDateTime(e.date||new Date());
    const local=new Uint8Array(30+nb.length),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x0800,true);lv.setUint16(8,0,true);lv.setUint16(10,dos.time,true);lv.setUint16(12,dos.date,true);lv.setUint32(14,crc,true);lv.setUint32(18,size,true);lv.setUint32(22,size,true);lv.setUint16(26,nb.length,true);lv.setUint16(28,0,true);local.set(nb,30);chunks.push(local,e.blob);
    const ch=new Uint8Array(46+nb.length),cv=new DataView(ch.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(10,0,true);cv.setUint16(12,dos.time,true);cv.setUint16(14,dos.date,true);cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,nb.length,true);cv.setUint16(30,0,true);cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);cv.setUint32(38,0,true);cv.setUint32(42,offset,true);ch.set(nb,46);central.push(ch);offset+=local.length+size;
  }
  const centralOffset=offset,centralSize=central.reduce((s,x)=>s+x.length,0);chunks.push(...central);
  const eocd=new Uint8Array(22),v=new DataView(eocd.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(4,0,true);v.setUint16(6,0,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,centralOffset,true);v.setUint16(20,0,true);chunks.push(eocd);
  return new Blob(chunks,{type:'application/zip'});
}
let CRC32_TABLE=null;
function crc32(bytes){
  if(!CRC32_TABLE){CRC32_TABLE=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;CRC32_TABLE[n]=c>>>0;}}
  let crc=0xFFFFFFFF;for(let i=0;i<bytes.length;i++)crc=CRC32_TABLE[(crc^bytes[i])&0xFF]^(crc>>>8);return (crc^0xFFFFFFFF)>>>0;
}
function zipDosDateTime(v){const d=v instanceof Date?v:new Date(v),y=Math.max(1980,d.getFullYear());return{time:((d.getHours()<<11)|(d.getMinutes()<<5)|Math.floor(d.getSeconds()/2))&0xFFFF,date:(((y-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xFFFF};}
async function downloadBlobToDevice(blob,name){const url=URL.createObjectURL(blob);try{const a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';a.style.display='none';document.body.appendChild(a);a.click();a.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),15000);}}

/* =========================================================
   ADD-ON V6.1 — FILTER PENJUALAN PER TANGGAL
   ========================================================= */
function ensureSalesDateFilterDefault(){const el=$('#salesDateFilter');if(el&&!el.value)el.value=jakartaDateKey(Date.now());}
function jakartaDateKey(v){const d=v instanceof Date?v:new Date(v),parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d),m=Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return `${m.year}-${m.month}-${m.day}`;}
function jakartaTimeKey(v){const d=v instanceof Date?v:new Date(v),parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(d),m=Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return `${m.hour}-${m.minute}-${m.second}`;}
function jakartaTimestampText(v){const d=v instanceof Date?v:new Date(v);return `${jakartaDateKey(d)} ${jakartaTimeKey(d).replaceAll('-',':')}`;}

async function refreshSalesByDate(preferNetwork=true){
  if(!session||isLogisticRole()||!$('#salesDateFilter'))return;
  ensureSalesDateFilterDefault();
  const date=String($('#salesDateFilter').value||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){renderSalesDateError('Pilih tanggal yang valid.');return;}
  setSalesDateLoading(true);
  try{
    const local=await getLocalSalesRowsByDate(session.username,date),cacheKey=`salesDate:v2:${String(session.username||'').toLowerCase()}:${date}`;
    let backend=await metaGet(cacheKey),state=backend?'CACHE BACKEND':'BELUM DIMUAT';
    if(preferNetwork&&navigator.onLine){
      try{const token=await metaGet(TOKEN_KEY);backend=await KtdBridge.call('getMySalesByDate',{token,date});await metaSet(cacheKey,backend);state='LIVE BACKEND';}
      catch(err){console.warn('Filter tanggal backend gagal:',err);state=backend?'CACHE BACKEND':'BACKEND TIDAK TERSEDIA';}
    }else if(!navigator.onLine)state=backend?'CACHE BACKEND • OFFLINE':'OFFLINE • BELUM ADA CACHE BACKEND';
    renderSalesDateRows(date,mergeSalesDateRows(backend?.rows||[],local),state);
  }catch(err){renderSalesDateError(String(err?.message||err));}
  finally{setSalesDateLoading(false);}
}
function valueToEpochMillis(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return s.length === 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function localRecordDateKey(record) {
  const explicit = String(record?.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;

  for (const candidate of [record?.clientTimestamp, record?.createdAt, record?.timestamp]) {
    const ms = valueToEpochMillis(candidate);
    if (Number.isFinite(ms)) return jakartaDateKey(ms);
  }
  return '';
}

async function getLocalSalesRowsByDate(username,date){
  const u=String(username||'').toLowerCase(),rows=await queueAll();
  return rows.filter(r=>String(r.ownerUsername||'').toLowerCase()===u&&localRecordDateKey(r)===date).map(r=>{
    const p=products.find(p=>String(p.kodeProduk||'')===String(r.kodeProduk||'')),qty=Number(r.qty||0),price=Number(r.harga??p?.harga??0);
    const rawTime=[r.clientTimestamp,r.createdAt,r.timestamp].map(valueToEpochMillis).find(Number.isFinite);
    const timestamp=Number.isFinite(rawTime)?jakartaTimestampText(rawTime):(String(r.timestamp||r.createdAt||date));
    return{idTransaksi:String(r.idTransaksi||''),idPesanan:String(r.idPesanan||''),timestamp,kodeProduk:String(r.kodeProduk||''),namaProduk:String(r.namaProduk||p?.namaProduk||r.kodeProduk||''),qty,satuan:String(r.satuan||p?.satuan||''),value:qty*price,payment:String(r.metodePembayaran||'').toUpperCase()==='QRIS'?'QRIS':'Cash',buktiPembayaran:String(r.buktiPembayaran||''),map:String(r.map||''),keterangan:String(r.keterangan||''),lokasi:String(r.lokasi||session?.lokasi||''),event:String(r.event||session?.event||''),source:'LOCAL',syncStatus:String(r.syncStatus||'PENDING')};
  });
}

function mergeSalesDateRows(backend,local){
  const m=new Map();(backend||[]).forEach(r=>{const k=String(r.idTransaksi||'');if(k)m.set(k,{...r,source:'BACKEND',syncStatus:'SYNCED'});});(local||[]).forEach(r=>{const k=String(r.idTransaksi||'');if(k&&!m.has(k))m.set(k,r);});return[...m.values()].sort((a,b)=>String(b.timestamp||'').localeCompare(String(a.timestamp||'')));
}
function renderSalesDateRows(date,rows,state){
  const s={qty:0,value:0,cash:0,qris:0,backend:0,local:0};rows.forEach(r=>{const q=Number(r.qty||0),v=Number(r.value||0);s.qty+=q;s.value+=v;if(String(r.payment||'').toUpperCase()==='QRIS')s.qris+=v;else s.cash+=v;if(r.source==='BACKEND')s.backend++;else s.local++;});
  $('#salesDateQty').textContent=formatNumber(s.qty);$('#salesDateValue').textContent=money(s.value);$('#salesDateCash').textContent=money(s.cash);$('#salesDateQris').textContent=money(s.qris);$('#salesDateSource').textContent=`${formatNumber(s.backend)} backend • ${formatNumber(s.local)} lokal`;$('#salesDateStatus').textContent=`${date} • ${state} • ${formatNumber(rows.length)} baris penjualan`;$('#salesDateStatus').classList.remove('error');
  const list=$('#salesDateList');if(!rows.length){list.innerHTML='<div class="empty-state">Tidak ada penjualan pada tanggal ini.</div>';return;}
  list.innerHTML=rows.map(r=>{const cls=r.source==='BACKEND'?'backend':'local',txt=r.source==='BACKEND'?'BACKEND':(r.syncStatus||'LOCAL'),mapOk=/^https:\/\//i.test(String(r.map||'')),proofOk=/^https:\/\//i.test(String(r.buktiPembayaran||''));return `<div class="sales-date-row"><div class="sales-date-main"><div class="sales-date-title"><b>${esc(r.namaProduk||r.kodeProduk)}</b><span class="sales-source ${cls}">${esc(txt)}</span></div><small>${esc(r.timestamp||'')} • ${esc(r.lokasi||'')}</small><small>Order ${esc(r.idPesanan||'-')} • Tx ${esc(r.idTransaksi||'-')} • ${esc(r.payment||'')}</small>${r.keterangan?`<small>${esc(r.keterangan)}</small>`:''}<div class="sales-date-links">${mapOk?`<a href="${esc(r.map)}" target="_blank" rel="noopener">MAP</a>`:'<span>MAP -</span>'}${proofOk?`<a href="${esc(r.buktiPembayaran)}" target="_blank" rel="noopener">BUKTI QRIS</a>`:(String(r.payment||'').toUpperCase()==='QRIS'?'<span>BUKTI QRIS -</span>':'')}</div></div><div class="sales-date-number"><b>${formatNumber(r.qty)} ${esc(r.satuan||'')}</b><strong>${money(r.value)}</strong></div></div>`;}).join('');
}
function renderSalesDateError(msg){$('#salesDateStatus').textContent=msg||'Gagal memuat data tanggal.';$('#salesDateStatus').classList.add('error');}
function setSalesDateLoading(on){setButton('#applySalesDateBtn',on,on?'MEMUAT...':'TAMPILKAN');}


/* =========================================================
   LOGISTIC / BARMEN MODULE
   ========================================================= */
const LOGISTIC_TYPE_META = {
  IN:{label:'STOCK MASUK',sign:1},
  OUT:{label:'STOCK KELUAR / TERPAKAI',sign:-1},
  RETURN_IN:{label:'RETUR MASUK',sign:1},
  DAMAGE:{label:'RUSAK / WASTE',sign:-1},
  SALE:{label:'PENJUALAN SPG',sign:-1}
};


function ensureInterviewDate() {
  const el = $('#interviewDate');
  if (el) el.value = jakartaDateKey(Date.now());
}

function selectedInterviewRadio(name) {
  return $(`#interviewView input[name="${name}"]:checked`)?.value || '';
}

function selectedInterviewChecks(name) {
  return $$(`#interviewView input[name="${name}"]:checked`).map(x => x.value);
}

function renderInterviewShiftPreview() {
  const before = [1,2,3].map(i => Number(selectedInterviewRadio(`beforeQ${i}`) || 0)).filter(Boolean);
  const after = [1,2,3].map(i => Number(selectedInterviewRadio(`afterQ${i}`) || 0)).filter(Boolean);
  const el = $('#interviewShiftPreview');
  if (!el) return;
  if (before.length !== 3 || after.length !== 3) { el.textContent = 'Lengkapi penilaian untuk melihat perubahan persepsi.'; return; }
  const b = before.reduce((a,v)=>a+v,0)/3;
  const a = after.reduce((a,v)=>a+v,0)/3;
  const shift = a-b;
  el.innerHTML = `Perubahan persepsi: <strong>${shift >= 0 ? '+' : ''}${shift.toFixed(2)}</strong> / 5`;
  el.classList.toggle('positive', shift > 0.05);
  el.classList.toggle('negative', shift < -0.05);
}

function resetConsumerInterviewForm() {
  const form = $('#consumerInterviewForm');
  if (form) form.reset();
  ensureInterviewDate();
  $('#interviewAge').value = '';
  $('#interviewGender').value = '';
  $('#interviewStatus').value = '';
  $('#interviewQty').value = '1';
  $('#interviewComment').value = '';
  interviewTried=false;
  $('#interviewAfterSection').classList.add('hidden');
  $('#interviewTriedBtn').disabled=false;
  $('#interviewTriedBtn').textContent='SUDAH MENCOBA PEACH TEA';
  $('#interviewTriedStatus').textContent='Belum dikonfirmasi.';
  $('#interviewTriedStatus').classList.remove('confirmed');
  $('#interviewShiftPreview').textContent = 'Lengkapi penilaian untuk melihat perubahan persepsi.';
  $('#interviewShiftPreview').classList.remove('positive','negative');
  resetInterviewPhotoPreview();
  interviewWizardStep=0;
  renderInterviewWizard();
}

function setupInterviewWizard(){
  const form=$('#consumerInterviewForm');
  if(!form || interviewWizardNavReady) return;
  interviewWizardSections=[...form.querySelectorAll(':scope > section.card.panel:not(.interview-response-extra)')];
  if(interviewWizardSections.length<6) return;
  interviewWizardNavReady=true;
  const stepper=document.createElement('div');
  stepper.id='interviewWizardStepper';
  stepper.className='interview-stepper';
  stepper.innerHTML='<div class="interview-step-progress"><span id="interviewStepProgressBar"></span></div><div class="interview-step-labels"><span data-step-label="0">Profil</span><span data-step-label="1">Sebelum</span><span data-step-label="2">Coba</span><span data-step-label="3">Sesudah</span><span data-step-label="4">Respon</span><span data-step-label="5">Foto</span></div>';
  form.parentNode.insertBefore(stepper,form);
  const nav=document.createElement('div');
  nav.id='interviewWizardNav';
  nav.className='interview-wizard-nav';
  nav.innerHTML='<button id="interviewBackBtn" class="btn-small" type="button">KEMBALI</button><button id="interviewNextBtn" class="btn-primary" type="button">LANJUT</button>';
  form.appendChild(nav);
  $('#interviewBackBtn').addEventListener('click',()=>{if(interviewWizardStep>0){interviewWizardStep--;renderInterviewWizard();}});
  $('#interviewNextBtn').addEventListener('click',handleInterviewWizardNext);
}
function formSectionsForInterviewWizard(){
  const form=$('#consumerInterviewForm');
  return form ? [...form.querySelectorAll(':scope > section.card.panel')] : [];
}
function renderInterviewWizard(){
  if(!interviewWizardNavReady)return;
  [...formSectionsForInterviewWizard()].forEach(section=>section.classList.add('wizard-hidden'));
  const active=interviewWizardSections[interviewWizardStep];
  if(active) active.classList.remove('wizard-hidden');
  const extra=$('.interview-response-extra');
  if(extra) extra.classList.toggle('wizard-hidden',interviewWizardStep!==4);
  const labels=$$('#interviewWizardStepper [data-step-label]');
  labels.forEach((el,i)=>{el.classList.toggle('active',i===interviewWizardStep);el.classList.toggle('done',i<interviewWizardStep);});
  const bar=$('#interviewStepProgressBar'); if(bar) bar.style.width=`${((interviewWizardStep+1)/6)*100}%`;
  const back=$('#interviewBackBtn'),next=$('#interviewNextBtn');
  if(back) back.disabled=interviewWizardStep===0;
  if(next){next.textContent=interviewWizardStep===5?'SIMPAN INTERVIEW':'LANJUT';}
  const step=interviewWizardStep;
  if(step===2 && !interviewTried){next.disabled=true;} else {next.disabled=false;}
  const actions=$('.interview-actions'); if(actions) actions.classList.toggle('wizard-hidden',true);
}
function interviewStepError(message){showMsg('#interviewSaveMsg',message,true);return false;}
function validateInterviewStep(step){
  if(step===0){
    if(!$('#interviewQty').value || Number($('#interviewQty').value)<1)return interviewStepError('Masukkan jumlah Peach Tea yang dibeli.');
    if(!$('#interviewAge').value)return interviewStepError('Pilih kelompok usia konsumen.');
    if(!$('#interviewGender').value)return interviewStepError('Pilih gender konsumen.');
    if(!$('#interviewStatus').value)return interviewStepError('Pilih status konsumen.');
    if(!selectedInterviewRadio('familiarity'))return interviewStepError('Pilih apakah konsumen pernah mengenal atau mengonsumsi Kratingdaeng.');
  }
  if(step===1){
    if(!selectedInterviewRadio('beforeFit'))return interviewStepError('Pilih image Kratingdaeng sebelum mencoba.');
    if([1,2,3].some(i=>!selectedInterviewRadio(`beforeQ${i}`)))return interviewStepError('Lengkapi tiga penilaian BEFORE.');
  }
  if(step===2 && !interviewTried)return interviewStepError('Lanjutkan setelah konsumen benar-benar mencoba Peach Tea.');
  if(step===3){
    if(!selectedInterviewRadio('afterFit'))return interviewStepError('Pilih image Kratingdaeng setelah mencoba.');
    if([1,2,3].some(i=>!selectedInterviewRadio(`afterQ${i}`)))return interviewStepError('Lengkapi tiga penilaian AFTER.');
  }
  if(step===4){
    if(!selectedInterviewChecks('purchaseReasons').length)return interviewStepError('Pilih minimal satu alasan konsumen memilih Peach Tea.');
    if(!selectedInterviewChecks('reasons').length)return interviewStepError('Pilih minimal satu hal yang membuat Peach Tea terasa cocok.');
    if(!selectedInterviewRadio('repeatPurchase')||!selectedInterviewRadio('recommend'))return interviewStepError('Lengkapi niat beli ulang dan rekomendasi.');
  }
  if(step===5){
    if(!$('#interviewPhotoConsent').checked)return interviewStepError('Minta persetujuan konsumen sebelum mengambil foto.');
    if(!currentInterviewPhotoId)return interviewStepError('Ambil foto konsumen terlebih dahulu.');
  }
  return true;
}
function handleInterviewWizardNext(){
  if(!validateInterviewStep(interviewWizardStep))return;
  if(interviewWizardStep<5){interviewWizardStep++;renderInterviewWizard();window.scrollTo({top:0,behavior:'smooth'});return;}
  saveConsumerInterview();
}

function validateInterviewForm() {
  const age = $('#interviewAge').value;
  const gender = $('#interviewGender').value;
  const consumerStatus = $('#interviewStatus').value;
  const qty = Math.max(1, Math.min(99, Number($('#interviewQty').value || 0)));
  const beforeFit = selectedInterviewRadio('beforeFit');
  const afterFit = selectedInterviewRadio('afterFit');
  const before = [1,2,3].map(i => Number(selectedInterviewRadio(`beforeQ${i}`) || 0));
  const after = [1,2,3].map(i => Number(selectedInterviewRadio(`afterQ${i}`) || 0));
  const reasons = selectedInterviewChecks('reasons');
  const purchaseReasons = selectedInterviewChecks('purchaseReasons');
  const repeat = selectedInterviewRadio('repeatPurchase');
  const recommend = selectedInterviewRadio('recommend');
  const familiarity = selectedInterviewRadio('familiarity');
  const photoUsageConsent = selectedInterviewRadio('photoUsageConsent') || 'TIDAK';
  if (!age) return {ok:false,error:'Pilih kelompok usia konsumen.'};
  if (!gender) return {ok:false,error:'Pilih gender konsumen.'};
  if (!consumerStatus) return {ok:false,error:'Pilih status konsumen.'};
  if (!qty || qty < 1) return {ok:false,error:'Jumlah Peach Tea harus minimal 1.'};
  if (!familiarity) return {ok:false,error:'Pilih apakah konsumen pernah mengenal/mengonsumsi Kratingdaeng sebelumnya.'};
  if (!beforeFit) return {ok:false,error:'Lengkapi pilihan image sebelum membeli.'};
  if (!interviewTried) return {ok:false,error:'Pastikan konsumen sudah mencoba Peach Tea sebelum masuk ke AFTER.'};
  if (!afterFit) return {ok:false,error:'Lengkapi pilihan image setelah mencoba.'};
  if (before.some(v=>v<1||v>5) || after.some(v=>v<1||v>5)) return {ok:false,error:'Lengkapi seluruh penilaian 1–5 sebelum dan sesudah.'};
  if (!purchaseReasons.length) return {ok:false,error:'Pilih minimal satu alasan konsumen memilih Peach Tea.'};
  if (!reasons.length) return {ok:false,error:'Pilih minimal satu hal yang membuat Peach Tea terasa cocok.'};
  if (!repeat || !recommend) return {ok:false,error:'Lengkapi niat beli ulang dan rekomendasi.'};
  if (!$('#interviewPhotoConsent').checked) return {ok:false,error:'Persetujuan foto konsumen wajib.'};
  if (!currentInterviewPhotoId) return {ok:false,error:'Ambil foto konsumen terlebih dahulu.'};
  return {ok:true,qty,age,gender,consumerStatus,beforeFit,afterFit,before,after,reasons,purchaseReasons,repeat,recommend,familiarity,photoUsageConsent};
}

async function saveConsumerInterview() {
  if (!session || !isTlRole()) return;
  const check = validateInterviewForm();
  if (!check.ok) { showMsg('#interviewSaveMsg', check.error, true); return; }
  const photo=await photoGet(currentInterviewPhotoId);
  if(!photo?.blob || photo.recordType!=='CONSUMER_INTERVIEW_PHOTO'){showMsg('#interviewSaveMsg','Foto konsumen tidak ditemukan. Ambil ulang foto.',true);return;}
  const now = Date.now();
  const id = 'INT-' + randomId8() + randomId8();
  const deviceId = await metaGet(DEVICE_KEY);
  photo.interviewId=id;
  photo.state='COMMITTED';
  photo.uploadStatus=photo.uploadStatus==='UPLOADED'?'UPLOADED':'PENDING';
  photo.ageGroup=check.age;
  photo.photoUsageConsent=check.photoUsageConsent;
  photo.updatedAt=new Date().toISOString();
  await photoPut(photo);
  const record = {
    idTransaksi:id,
    idInterview:id,
    recordType:'CONSUMER_INTERVIEW',
    ownerUsername:String(session.username || '').toLowerCase(),
    tlUsername:session.username || '',
    namaTL:session.namaUser || session.username || '',
    event:session.event || '',
    lokasi:session.lokasi || '',
    interviewDate:$('#interviewDate').value || jakartaDateKey(now),
    clientTimestamp:now,
    ageGroup:check.age,
    peachTeaQty:check.qty,
    familiarity:check.familiarity,
    beforeFit:check.beforeFit,
    beforeQ1:check.before[0],
    beforeQ2:check.before[1],
    beforeQ3:check.before[2],
    afterFit:check.afterFit,
    afterQ1:check.after[0],
    afterQ2:check.after[1],
    afterQ3:check.after[2],
    reasons:check.reasons,
    repeatPurchase:check.repeat,
    recommend:check.recommend,
    comment:$('#interviewComment').value.trim().slice(0,500),
    deviceId,
    gender:check.gender,
    consumerStatus:check.consumerStatus,
    purchaseReasons:check.purchaseReasons,
    triedPeachTea:'YA',
    photoConsent:'YA',
    photoUsageConsent:check.photoUsageConsent,
    photoId:photo.photoId,
    photoDriveUrl:photo.driveUrl||'',
    photoDriveFileId:photo.driveFileId||'',
    photoDriveFileName:photo.driveFileName||'',
    createdAt:now,
    syncStatus:'PENDING',
    lastSyncError:''
  };
  await queuePut(record);
  currentInterviewPhotoId='';
  resetConsumerInterviewForm();
  showMsg('#interviewSaveMsg', navigator.onLine ? 'Interview tersimpan • foto aman di perangkat • sedang dikirim…' : 'Interview + foto tersimpan di perangkat.', false);
  await updateInterviewMetrics();
  await refreshConsumerInterviewSummary();
  if (navigator.onLine) setTimeout(syncAll, 250);
}

async function refreshConsumerInterviewSummary() {
  if (!session || !isTlRole()) return;
  const date = $('#interviewDate')?.value || jakartaDateKey(Date.now());
  const localRows = (await queueAll()).filter(r => String(r.ownerUsername||'').toLowerCase() === String(session.username||'').toLowerCase() && r.recordType === 'CONSUMER_INTERVIEW');
  let backend = {ok:true,total:0,beforeAvg:0,afterAvg:0,shift:0,repeatRate:0,firstTimeRate:0,beforeProfile:{},afterProfile:{},topReasons:[],purchaseReasons:[],byAge:{},byGender:{},byStatus:{},samplingTargetPerVenue:Number(window.KTD_CONFIG?.INTERVIEW_TARGET_PER_VENUE||20)};
  if (navigator.onLine) {
    try { backend = await KtdBridge.call('getConsumerInterviewSummary', {token:await metaGet(TOKEN_KEY), date, location:session.lokasi || ''}); }
    catch (_) {}
  }
  const localForDate = localRows.filter(r => String(r.interviewDate || jakartaDateKey(r.createdAt)).slice(0,10) === date);
  const localStats = summarizeLocalInterviews(localForDate);
  const total = Number(backend.total||0) + localStats.total;
  const beforeAvg = combineAverage(Number(backend.beforeAvg||0), Number(backend.total||0), localStats.beforeAvg, localStats.total);
  const afterAvg = combineAverage(Number(backend.afterAvg||0), Number(backend.total||0), localStats.afterAvg, localStats.total);
  const shift = total ? afterAvg-beforeAvg : 0;
  $('#interviewTotalCount').textContent = formatNumber(total);
  $('#interviewBeforeAvg').textContent = total ? beforeAvg.toFixed(2) : '—';
  $('#interviewAfterAvg').textContent = total ? afterAvg.toFixed(2) : '—';
  $('#interviewShiftScore').textContent = total ? `${shift >= 0 ? '+' : ''}${shift.toFixed(2)}` : '—';
  $('#interviewRepeatRate').textContent = total ? `${Math.round(((Number(backend.repeatRate||0)*Number(backend.total||0)) + (localStats.repeatYes)) / total * 100)}%` : '—';
  const beforeGenZ = Number((backend.beforeProfile || {})['Anak muda / Gen Z'] || 0) + Number((localStats.beforeProfile || {})['Anak muda / Gen Z'] || 0);
  const afterGenZ = Number((backend.afterProfile || {})['Anak muda / Gen Z'] || 0) + Number((localStats.afterProfile || {})['Anak muda / Gen Z'] || 0);
  $('#interviewGenZShift').textContent = total ? `${Math.round(afterGenZ/total*100)}%` : '—';
  $('#interviewGenZShiftDetail').textContent = total ? `Sebelum ${Math.round(beforeGenZ/total*100)}% → Sesudah ${Math.round(afterGenZ/total*100)}%` : 'Belum ada data';
  const target=Number(backend.samplingTargetPerVenue||window.KTD_CONFIG?.INTERVIEW_TARGET_PER_VENUE||20);
  $('#interviewSamplingStatus').textContent=`${formatNumber(total)} / ${formatNumber(target)}`;
  renderInterviewProfiles(backend.beforeProfile || {}, localStats.beforeProfile, '#interviewBeforeProfile');
  renderInterviewProfiles(backend.afterProfile || {}, localStats.afterProfile, '#interviewAfterProfile');
  renderInterviewProfiles(backend.byAge || {}, localStats.byAge, '#interviewAgeProfile');
  renderInterviewProfiles(backend.byGender || {}, localStats.byGender, '#interviewGenderProfile');
  renderInterviewProfiles(backend.byStatus || {}, localStats.byStatus, '#interviewStatusProfile');
  renderInterviewReasons(mergeReasonStats(backend.purchaseReasons || [], localStats.purchaseReasons), '#interviewPurchaseReasons');
  renderInterviewReasons(mergeReasonStats(backend.topReasons || [], localStats.topReasons), '#interviewReasons');
  const status = $('#interviewSummaryStatus');
  if (status) status.textContent = `${date} • ${total} interview • backend ${Number(backend.total||0)} • lokal ${localStats.total}`;
}

function combineAverage(a,na,b,nb){ const total=Number(na||0)+Number(nb||0); return total ? ((Number(a||0)*Number(na||0))+(Number(b||0)*Number(nb||0)))/total : 0; }
function summarizeLocalInterviews(rows){
  if(!rows.length)return {total:0,beforeAvg:0,afterAvg:0,repeatYes:0,beforeProfile:{},afterProfile:{},byAge:{},byGender:{},byStatus:{},topReasons:[],purchaseReasons:[]};
  const bp={},ap={},age={},gender={},status={},reasons={},purchaseReasons={}; let bsum=0,asum=0,repeatYes=0;
  rows.forEach(r=>{ const b=[r.beforeQ1,r.beforeQ2,r.beforeQ3].map(Number); const a=[r.afterQ1,r.afterQ2,r.afterQ3].map(Number); bsum+=b.reduce((x,v)=>x+v,0)/3; asum+=a.reduce((x,v)=>x+v,0)/3; bp[r.beforeFit]=(bp[r.beforeFit]||0)+1; ap[r.afterFit]=(ap[r.afterFit]||0)+1; age[r.ageGroup]=(age[r.ageGroup]||0)+1; gender[r.gender]=(gender[r.gender]||0)+1; status[r.consumerStatus]=(status[r.consumerStatus]||0)+1; if(String(r.repeatPurchase||'').toUpperCase()==='YA')repeatYes++; (r.reasons||[]).forEach(x=>reasons[x]=(reasons[x]||0)+1); (r.purchaseReasons||[]).forEach(x=>purchaseReasons[x]=(purchaseReasons[x]||0)+1); });
  return {total:rows.length,beforeAvg:bsum/rows.length,afterAvg:asum/rows.length,repeatYes,beforeProfile:bp,afterProfile:ap,byAge:age,byGender:gender,byStatus:status,topReasons:Object.entries(reasons).map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count).slice(0,6),purchaseReasons:Object.entries(purchaseReasons).map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count).slice(0,6)};
}
function mergeReasonStats(server, local){ const m={}; [...(server||[]),...(local||[])].forEach(x=>{const k=String(x.label||''); if(!k)return; m[k]=(m[k]||0)+Number(x.count||0);}); return Object.entries(m).map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count).slice(0,6); }
function renderInterviewProfiles(server,local,selector){ const m={}; Object.entries(server||{}).forEach(([k,v])=>m[k]=Number(v||0)); Object.entries(local||{}).forEach(([k,v])=>m[k]=(m[k]||0)+Number(v||0)); const el=$(selector); if(!el)return; const rows=Object.entries(m).filter(([k])=>k&&k!=='undefined').sort((a,b)=>b[1]-a[1]); el.innerHTML=rows.length?rows.map(([k,v])=>`<div class="insight-row"><span>${esc(k)}</span><strong>${formatNumber(v)}</strong></div>`).join(''):'<div class="empty-state">Belum ada data.</div>'; }
function renderInterviewReasons(rows,selector){ const el=$(selector); if(!el)return; el.innerHTML=(rows||[]).length?(rows||[]).map(x=>`<div class="insight-row"><span>${esc(x.label)}</span><strong>${formatNumber(x.count)}</strong></div>`).join(''):'<div class="empty-state">Belum ada data.</div>'; }

function renderInterviewSyncStatus(pending,errors,online,syncing){
  const status=$('#interviewSyncStatus'), headline=$('#interviewSyncHeadline'), detail=$('#interviewSyncDetail'); if(!status||!headline||!detail)return;
  let h='Semua interview tersimpan',d='Interview akan dikirim otomatis saat koneksi tersedia.',state='ready';
  if(syncing){h='Menyinkronkan interview…';d='Jangan tutup aplikasi sampai proses selesai.';state='syncing';}
  else if(!online){h='Offline — interview tetap tersimpan';d=pending?`${formatNumber(pending)} interview menunggu koneksi.`:'Interview baru akan dikirim saat koneksi tersedia.';state='offline';}
  else if(errors){h=`${formatNumber(errors)} interview perlu dikirim ulang`;d=pending?`${formatNumber(pending)} interview masih menunggu pengiriman.`:'Tekan SYNC DATA untuk mencoba lagi.';state='attention';}
  else if(pending){h=`${formatNumber(pending)} interview menunggu pengiriman`;d='Akan dikirim otomatis saat koneksi siap.';state='attention';}
  headline.textContent=h;detail.textContent=d;status.classList.remove('syncing','attention','offline');if(state!=='ready')status.classList.add(state);
}

async function updateInterviewMetrics(){
  if(!session||!isTlRole())return;
  const pending=await interviewPendingCountForUser(session.username), errors=await interviewErrorCountForUser(session.username), today=await interviewTodayCountForUser(session.username);
  $('#interviewPendingCount').textContent=String(pending);$('#interviewPendingChip').textContent=`${pending} BELUM TERKIRIM`;$('#interviewErrorCount').textContent=String(errors);$('#interviewTodayCount').textContent=String(today); renderInterviewSyncStatus(pending,errors,navigator.onLine,syncInProgress);
}

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

function getLogisticCatalog() {
  const seen = new Set();
  const out = [];

  (products || []).forEach(p => {
    const code = String(p.kodeProduk || '');
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push({
      kodeProduk:code,
      namaProduk:p.namaProduk,
      satuan:p.satuan,
      itemType:'PRODUCT',
      category:p.subKategori || p.kategori || 'PRODUCT',
      source:'PRODUCT'
    });
  });

  (logisticItems || []).forEach(item => {
    const code = String(item.kodeProduk || '');
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push({
      ...item,
      itemType:String(item.itemType || 'CONSUMABLE').toUpperCase(),
      category:item.category || item.subKategori || item.itemType || 'LAINNYA',
      source:'LOGISTIC'
    });
  });

  return out;
}

function formatLogisticQty(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('id-ID', {maximumFractionDigits:3}).format(n);
}

function renderLogisticCategories() {
  const catalog = getLogisticCatalog();
  const types = ['ALL'];
  ['PRODUCT','CONSUMABLE','ASSET'].forEach(type => {
    if (catalog.some(item => item.itemType === type)) types.push(type);
  });

  $('#logisticProductTabs').innerHTML = types.map(type => {
    const label = type === 'ALL' ? 'SEMUA' : (type === 'PRODUCT' ? 'PRODUK' : type);
    return `<button class="category-tab ${type === logisticCategory ? 'active' : ''}" data-log-cat="${esc(type)}">${esc(label)}</button>`;
  }).join('');

  $$('[data-log-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      logisticCategory = btn.dataset.logCat;
      renderLogisticCategories();
      renderLogisticProducts();
    });
  });
}



function renderLogisticProducts() {
  const catalog = getLogisticCatalog();
  const filtered = catalog.filter(item => logisticCategory === 'ALL' || item.itemType === logisticCategory);
  $('#logisticProductList').innerHTML = filtered.length ? filtered.map(item => {
    const qty = Number(logisticCart[item.kodeProduk] || 0);
    const typeLabel = item.itemType === 'PRODUCT' ? 'PRODUCT' : item.itemType;
    return `<div class="product-card ${qty ? 'in-cart' : ''}" data-log-card="${esc(item.kodeProduk)}">
      <div><b>${esc(item.namaProduk)}</b><span class="price">${esc(item.kodeProduk)} • ${esc(item.satuan)} • ${esc(typeLabel)}</span></div>
      <div class="product-controls logistic-product-controls">
        <button type="button" data-log-action="minus" data-code="${esc(item.kodeProduk)}" aria-label="Kurangi qty">−</button>
        <input class="logistic-qty-input" type="number" inputmode="decimal" min="0" max="999999" step="0.01" value="${qty || ''}" placeholder="0" data-log-qty="${esc(item.kodeProduk)}" aria-label="Qty ${esc(item.namaProduk)}">
        <button type="button" class="plus" data-log-action="plus" data-code="${esc(item.kodeProduk)}" aria-label="Tambah qty">+</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty-state">Belum ada item pada kategori ini.</div>';

  $$('[data-log-action]').forEach(btn => {
    btn.addEventListener('click', () => changeLogisticCart(btn.dataset.code, btn.dataset.logAction === 'plus' ? 1 : -1));
  });

  $$('[data-log-qty]').forEach(input => {
    input.addEventListener('input', () => setLogisticCartQty(input.dataset.logQty, input.value, false));
    input.addEventListener('change', () => setLogisticCartQty(input.dataset.logQty, input.value, true));
    input.addEventListener('blur', () => {
      const qty = Number(logisticCart[input.dataset.logQty] || 0);
      input.value = qty ? String(qty) : '';
    });
  });
}



function setLogisticCartQty(code, rawValue, normalizeInput = false) {
  let qty = Number(String(rawValue || '0').replace(',', '.'));
  if (!Number.isFinite(qty)) qty = 0;
  qty = Math.max(0, Math.min(999999, Math.round(qty * 1000) / 1000));

  if (qty === 0) delete logisticCart[code];
  else logisticCart[code] = qty;

  const card = document.querySelector(`[data-log-card="${cssEsc(code)}"]`);
  if (card) card.classList.toggle('in-cart', qty > 0);

  if (normalizeInput) {
    const input = document.querySelector(`[data-log-qty="${cssEsc(code)}"]`);
    if (input) input.value = qty ? String(qty) : '';
  }

  renderLogisticCart();
}



function changeLogisticCart(code, delta) {
  const next = Math.max(0, Math.min(9999, Number(logisticCart[code] || 0) + delta));
  setLogisticCartQty(code, next, true);
  if (navigator.vibrate) navigator.vibrate(10);
}

function logisticCartLines() {
  return getLogisticCatalog().filter(item => Number(logisticCart[item.kodeProduk] || 0) > 0);
}



function renderLogisticCart() {
  const lines = logisticCartLines();
  const qty = lines.reduce((sum, item) => sum + Number(logisticCart[item.kodeProduk] || 0), 0);
  const meta = LOGISTIC_TYPE_META[logisticType] || LOGISTIC_TYPE_META.IN;

  $('#logisticCartInfo').textContent = lines.length ? `${lines.length} item • ${formatLogisticQty(qty)} qty` : 'Belum ada item';
  $('#logisticCartList').innerHTML = lines.length ? lines.map(item => {
    const q = Number(logisticCart[item.kodeProduk] || 0);
    return `<div class="cart-row"><div><b>${esc(item.namaProduk)}</b><span>${esc(item.kodeProduk)} • ${esc(item.satuan)} • ${esc(item.itemType)}</span></div><strong>${formatLogisticQty(q)} qty</strong></div>`;
  }).join('') : '<div class="cart-empty">Pilih produk, consumable, atau asset di atas.</div>';

  $('#logisticTotalQty').textContent = formatLogisticQty(qty);
  $('#logisticTypeLabel').textContent = `${meta.sign > 0 ? '+' : '−'} ${meta.label}`;
}



async function saveLogisticMovement() {
  if (!session || !isLogisticRole()) return;
  const lines = logisticCartLines();
  if (!lines.length) {
    showMsg('#logisticSaveMsg', 'Pilih minimal 1 item.', true);
    return;
  }

  const location = isBarmenRole() ? session.lokasi : ($('#logisticLocation').value || session.lokasi);
  if (!location) {
    showMsg('#logisticSaveMsg', 'Lokasi stock belum dipilih.', true);
    return;
  }

  const type = $('#logisticType').value || 'IN';
  const manualTypes = ['IN','OUT','RETURN_IN','DAMAGE'];
  if (!manualTypes.includes(type)) {
    showMsg('#logisticSaveMsg', 'Jenis aktivitas logistic tidak valid.', true);
    return;
  }

  const now = Date.now();
  const batchId = 'LB-' + randomId8();
  const deviceId = await metaGet(DEVICE_KEY);
  const note = $('#logisticNote').value.trim();

  const records = lines.map((item, index) => ({
    idLogistic: 'LG-' + randomId8(),
    batchId,
    clientTimestamp: now + index,
    event: session.event,
    lokasi: location,
    tipe: type,
    kodeProduk: item.kodeProduk,
    namaProduk: item.namaProduk,
    qty: Number(logisticCart[item.kodeProduk] || 0),
    satuan: item.satuan,
    itemType: item.itemType,
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
  showMsg('#logisticSaveMsg', navigator.onLine ? 'Movement tersimpan • sedang dikirim…' : 'Movement tersimpan di perangkat.', false);

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
      if (Array.isArray(logisticServerSummary?.catalog)) {
        logisticItems = logisticServerSummary.catalog.filter(x => String(x.source || '').toUpperCase() === 'LOGISTIC');
        renderLogisticCategories();
        renderLogisticProducts();
      }
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
  for (const item of getLogisticCatalog()) {
    map.set(item.kodeProduk, {
      kodeProduk:item.kodeProduk,namaProduk:item.namaProduk,satuan:item.satuan,
      itemType:item.itemType,category:item.category,source:item.source,stock:0
    });
  }
  rows.forEach(r => {
    if (!map.has(r.kodeProduk)) map.set(r.kodeProduk, {kodeProduk:r.kodeProduk,namaProduk:r.namaProduk,satuan:r.satuan,itemType:r.itemType || 'UNKNOWN',category:'LAINNYA',source:'LOCAL',stock:0});
    const meta = LOGISTIC_TYPE_META[r.tipe] || {sign:0};
    map.get(r.kodeProduk).stock += Number(r.qty || 0) * meta.sign;
  });

  const recent = rows.slice().sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0,25).map(r => ({
    idLogistic:r.idLogistic,timestamp:r.createdAt,tipe:r.tipe,kodeProduk:r.kodeProduk,namaProduk:r.namaProduk,
    qty:Number(r.qty || 0),qtySigned:Number(r.qty || 0) * (LOGISTIC_TYPE_META[r.tipe]?.sign || 0),
    satuan:r.satuan,namaUser:r.namaUser || r.username,role:r.role || '',keterangan:r.keterangan || '',local:true
  }));

  return {location, stockByItem:[...map.values()], recent};
}



function mergeLogisticSummary(server, local) {
  const stockMap = new Map();
  getLogisticCatalog().forEach(item => stockMap.set(item.kodeProduk, {
    kodeProduk:item.kodeProduk,namaProduk:item.namaProduk,satuan:item.satuan,
    itemType:item.itemType,category:item.category,source:item.source,stock:0
  }));

  for (const source of [server?.stockByItem || [], local?.stockByItem || []]) {
    source.forEach(x => {
      const key = x.kodeProduk || x.namaProduk;
      if (!stockMap.has(key)) stockMap.set(key, {kodeProduk:x.kodeProduk,namaProduk:x.namaProduk,satuan:x.satuan,itemType:x.itemType || 'UNKNOWN',category:x.category || 'LAINNYA',source:x.source || 'UNKNOWN',stock:0});
      const row = stockMap.get(key);
      row.stock += Number(x.stock || 0);
      if (x.itemType) row.itemType = x.itemType;
      if (x.category) row.category = x.category;
    });
  }

  const recent = [...(local?.recent || []), ...(server?.recent || [])]
    .sort((a,b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0,50);

  return {location:local?.location || server?.location || logisticLocation, stockByItem:[...stockMap.values()], recent};
}



function renderLogisticSummary(summary) {
  const location = summary?.location || logisticLocation || session?.lokasi || '';
  $('#logisticSummaryLocation').textContent = `${location} • ${session?.event || ''}`;
  const stock = (summary?.stockByItem || []).sort((a,b) => {
    const typeCompare = String(a.itemType || '').localeCompare(String(b.itemType || ''));
    return typeCompare || String(a.namaProduk).localeCompare(String(b.namaProduk));
  });

  $('#logisticStockTotal').textContent = formatNumber(stock.length);
  $('#logisticStockList').classList.toggle('empty-state', !stock.length);
  $('#logisticStockList').innerHTML = stock.length ? stock.map(x => {
    const cls = Number(x.stock) < 0 ? 'stock-negative' : (Number(x.stock) === 0 ? 'stock-zero' : '');
    return `<div class="summary-row"><div><b>${esc(x.namaProduk || x.kodeProduk)}</b><small>${esc(x.kodeProduk || '')} • ${esc(x.satuan || '')} • ${esc(x.itemType || 'ITEM')}</small></div><div class="numbers"><strong class="${cls}">${formatLogisticQty(x.stock)} qty</strong></div></div>`;
  }).join('') : 'Belum ada item stock.';

  const recent = summary?.recent || [];
  $('#logisticRecentList').classList.toggle('empty-state', !recent.length);
  $('#logisticRecentList').innerHTML = recent.length ? recent.map(x => {
    const signed = Number(x.qtySigned || 0);
    const label = x.tipe === 'AUTO_USAGE' ? 'AUTO CONSUMABLE' : (LOGISTIC_TYPE_META[x.tipe]?.label || x.tipe || '');
    return `<div class="logistic-history-row"><div><b>${esc(x.namaProduk || x.kodeProduk)}</b><span>${esc(label)} • ${esc(x.namaUser || '')}${x.local ? ' • LOCAL/PENDING' : ''}</span><small>${formatDateTime(x.timestamp)}${x.keterangan ? ' • ' + esc(x.keterangan) : ''}</small></div><div class="movement"><strong class="${signed >= 0 ? 'movement-positive' : 'movement-negative'}">${signed >= 0 ? '+' : ''}${formatLogisticQty(signed)}</strong><span>${esc(x.satuan || '')}</span></div></div>`;
  }).join('') : 'Belum ada movement.';
}



async function updateMetrics() {
  if (!session) return;

  const off = await metaGet(OFFLINE_SINCE_KEY);
  const last = await metaGet(LAST_SYNC_KEY);
  const online = navigator.onLine;

  if (isLogisticRole()) {
    const pending = await logisticPendingCountForUser(session.username);
    const errors = await logisticErrorCountForUser(session.username);
    const today = await logisticTodayCountForUser(session.username);
    $('#logisticPendingCount').textContent = String(pending);
    $('#logisticPendingChip').textContent = `${pending} BELUM TERKIRIM`;
    $('#logisticErrorCount').textContent = String(errors);
    $('#logisticTodayCount').textContent = String(today);
    $('#logisticOfflineDuration').textContent = off ? formatDuration(Date.now() - new Date(off).getTime()) : '0m';
    $('#logisticLastSyncAt').textContent = last ? formatDateTime(last) : 'Belum pernah';
    renderLogisticSyncStatus(pending, errors, online, syncInProgress);
    return;
  }

  if (isTlRole()) {
    const pending = await interviewPendingCountForUser(session.username);
    const errors = await interviewErrorCountForUser(session.username);
    const today = await interviewTodayCountForUser(session.username);
    $('#interviewPendingCount').textContent = String(pending);
    $('#interviewPendingChip').textContent = `${pending} BELUM TERKIRIM`;
    $('#interviewErrorCount').textContent = String(errors);
    $('#interviewTodayCount').textContent = String(today);
    $('#interviewOfflineDuration').textContent = off ? formatDuration(Date.now() - new Date(off).getTime()) : '0m';
    $('#interviewLastSyncAt').textContent = last ? formatDateTime(last) : 'Belum pernah';
    renderInterviewSyncStatus(pending, errors, online, syncInProgress);
    return;
  }

  const pending = await queueCountForUser(session.username);
  const errors = await queueErrorCountForUser(session.username);
  const photos = await photoPendingCountForUser(session.username);
  $('#pendingCount').textContent = String(pending);
  $('#pendingChip').textContent = `${pending} BELUM TERKIRIM`;
  $('#photoPendingCount').textContent = String(photos);
  $('#errorCount').textContent = String(errors);
  $('#offlineDuration').textContent = off ? formatDuration(Date.now() - new Date(off).getTime()) : '0m';
  $('#lastSyncAt').textContent = last ? formatDateTime(last) : 'Belum pernah';
  renderSalesSyncStatus(pending, errors, photos, online, syncInProgress);
}

function renderSalesSyncStatus(pending, errors, photos, online, syncing) {
  const status = $('#syncStatus');
  const headlineEls = ['#syncHeadlineCard'].map($).filter(Boolean);
  const detailEls = ['#syncDetailCard'].map($).filter(Boolean);
  if (!headlineEls.length) return;

  let headline = 'Semua data tersimpan';
  let detail = 'Sinkronisasi otomatis aktif.';
  let state = 'ready';

  if (syncing) {
    headline = 'Menyinkronkan data…';
    detail = 'Jangan tutup aplikasi sampai proses selesai.';
    state = 'syncing';
  } else if (!online) {
    headline = 'Offline — data tetap tersimpan';
    detail = pending || photos ? `${formatNumber(pending)} data dan ${formatNumber(photos)} bukti menunggu koneksi.` : 'Data baru akan dikirim saat koneksi tersedia.';
    state = 'offline';
  } else if (errors) {
    headline = `${formatNumber(errors)} data perlu dikirim ulang`;
    detail = pending ? `${formatNumber(pending)} data masih menunggu pengiriman.` : 'Buka detail sinkronisasi untuk mencoba lagi.';
    state = 'attention';
  } else if (pending || photos) {
    headline = `${formatNumber(pending)} data menunggu pengiriman`;
    detail = photos ? `${formatNumber(photos)} bukti pembayaran juga menunggu backup.` : 'Akan dikirim otomatis saat koneksi siap.';
    state = 'attention';
  }

  headlineEls.forEach(el => { el.textContent = headline; });
  detailEls.forEach(el => { el.textContent = detail; });
  if (status) {
    status.classList.remove('syncing','attention','offline');
    if (state !== 'ready') status.classList.add(state);
  }
}

function renderLogisticSyncStatus(pending, errors, online, syncing) {
  const status = $('#logisticSyncStatus');
  const headline = $('#logisticSyncHeadline');
  const detail = $('#logisticSyncDetail');
  if (!status || !headline || !detail) return;

  let h = 'Semua data tersimpan';
  let d = 'Sinkronisasi otomatis aktif.';
  let state = 'ready';
  if (syncing) { h = 'Menyinkronkan data…'; d = 'Jangan tutup aplikasi sampai proses selesai.'; state = 'syncing'; }
  else if (!online) { h = 'Offline — data tetap tersimpan'; d = pending ? `${formatNumber(pending)} movement menunggu koneksi.` : 'Movement baru akan dikirim saat koneksi tersedia.'; state = 'offline'; }
  else if (errors) { h = `${formatNumber(errors)} movement perlu dikirim ulang`; d = pending ? `${formatNumber(pending)} movement masih menunggu pengiriman.` : 'Buka detail status untuk mencoba lagi.'; state = 'attention'; }
  else if (pending) { h = `${formatNumber(pending)} movement menunggu pengiriman`; d = 'Akan dikirim otomatis saat koneksi siap.'; state = 'attention'; }
  headline.textContent = h;
  detail.textContent = d;
  status.classList.remove('syncing','attention','offline');
  if (state !== 'ready') status.classList.add(state);
}

function updateNetworkState(forceSyncing) {
  const online = navigator.onLine;
  $('#offlineBar').classList.toggle('hidden', online);
  const text = forceSyncing || syncInProgress ? 'SYNCING...' : (online ? 'ONLINE' : 'OFFLINE');
  if ($('#netStatus')) $('#netStatus').textContent = text;
  if ($('#logisticNetStatus')) $('#logisticNetStatus').textContent = text;
  if ($('#interviewNetStatus')) $('#interviewNetStatus').textContent = text;
  if ($('#syncStatus') && (forceSyncing || syncInProgress)) $('#syncStatus').classList.add('syncing');
  if ($('#logisticSyncStatus') && (forceSyncing || syncInProgress)) $('#logisticSyncStatus').classList.add('syncing');
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

function photoDelete(id) {
  return reqP(store(STORE_PHOTOS, 'readwrite').delete(id));
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


async function getPendingInterviewsForUser(username, limit) {
  const u = String(username || '').toLowerCase();
  const rows = await queueAll();
  return rows.filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType === 'CONSUMER_INTERVIEW' && r.syncStatus !== 'ERROR')
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(0, limit);
}

async function interviewPendingCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType === 'CONSUMER_INTERVIEW' && r.syncStatus !== 'ERROR').length;
}

async function interviewErrorCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType === 'CONSUMER_INTERVIEW' && r.syncStatus === 'ERROR').length;
}

async function interviewTodayCountForUser(username) {
  const u = String(username || '').toLowerCase();
  const start = new Date(); start.setHours(0,0,0,0);
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType === 'CONSUMER_INTERVIEW' && Number(r.createdAt || 0) >= start.getTime()).length;
}

async function resetInterviewErrorsForUser(username) {
  const u = String(username || '').toLowerCase();
  const rows = await queueAll();
  const mine = rows.filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType === 'CONSUMER_INTERVIEW' && r.syncStatus === 'ERROR');
  mine.forEach(r => { r.syncStatus = 'PENDING'; r.lastSyncError = ''; r.forceRetryAt = new Date().toISOString(); });
  if (mine.length) await queuePutMany(mine);
  return mine.length;
}

async function syncInterviewQueue(options = {}) {
  const token = await metaGet(TOKEN_KEY);
  if (!token || !session || !navigator.onLine || !isTlRole()) {
    return {totalSynced:0,pendingRemaining:session ? await interviewPendingCountForUser(session.username) : 0,errorRemaining:session ? await interviewErrorCountForUser(session.username) : 0};
  }
  if (options.retryErrors) await resetInterviewErrorsForUser(session.username);
  let totalSynced = 0;
  while (navigator.onLine) {
    const pending = await getPendingInterviewsForUser(session.username, Number(window.KTD_CONFIG?.INTERVIEW_BATCH_SIZE || 50));
    if (!pending.length) break;
    pending.forEach(row => { row.syncStatus = 'SYNCING'; row.lastSyncAttempt = new Date().toISOString(); });
    await queuePutMany(pending);
    let result;
    try {
      result = await KtdBridge.call('syncConsumerInterviews', {token, records:pending});
    } catch (err) {
      pending.forEach(row => { row.syncStatus='PENDING'; row.lastSyncError=String(err?.message || err); });
      await queuePutMany(pending);
      throw err;
    }
    const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
    const rejectedMap = new Map((result.rejected || []).map(x => [x.idInterview, x.error]));
    for (const row of pending) {
      if (accepted.has(row.idInterview)) { await queueDelete(row.idTransaksi); totalSynced++; }
      else if (rejectedMap.has(row.idInterview)) { row.syncStatus='ERROR'; row.lastSyncError=rejectedMap.get(row.idInterview)||'Ditolak server.'; await queuePut(row); }
      else { row.syncStatus='PENDING'; row.lastSyncError='Server belum mengonfirmasi interview.'; await queuePut(row); }
    }
    await new Promise(r => setTimeout(r, 60));
  }
  const pendingRemaining = await interviewPendingCountForUser(session.username);
  const errorRemaining = await interviewErrorCountForUser(session.username);
  return {totalSynced,pendingRemaining,errorRemaining};
}

async function getPendingForUser(username, limit) {
  const u = String(username || '').toLowerCase();
  const rows = await queueAll();
  return rows.filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType !== 'CONSUMER_INTERVIEW' && r.syncStatus !== 'ERROR')
    .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(0, limit);
}

async function queueCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType !== 'CONSUMER_INTERVIEW' && r.syncStatus !== 'ERROR').length;
}

async function queueErrorCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await queueAll()).filter(r => String(r.ownerUsername || '').toLowerCase() === u && r.recordType !== 'CONSUMER_INTERVIEW' && r.syncStatus === 'ERROR').length;
}

async function photoPendingCountForUser(username) {
  const u = String(username || '').toLowerCase();
  return (await photoAll()).filter(p => (!p.recordType || p.recordType === 'QRIS_PROOF') && String(p.ownerUsername || '').toLowerCase() === u && p.state === 'COMMITTED' && p.uploadStatus !== 'UPLOADED').length;
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
function cssEsc(value) {
  const text = String(value ?? '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
  return text.replace(/([\\"'\[\]#. :>+~*=()])/g, '\\$1');
}

function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
