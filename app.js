const DB_NAME='ktd_sales_offline_v2';
const DB_VERSION=1;
const Q_STORE='queue';
const META_STORE='meta';
const OFFLINE_SINCE_KEY='offlineSince';
const LAST_SYNC_KEY='lastSuccessfulSync';
const MAX_LOCAL_QUEUE_WARNING=10000;
const SYNC_BATCH_SIZE=120;
const TOKEN_KEY='authToken';
const CACHE_KEY='cachedSession';
const DEVICE_KEY='deviceId';

let syncInProgress=false;
let db, session=null, sessionToken='', products=[], venues=[];
let selectedCategory='ALL', payment='Cash', syncing=false;
let cart={};
let serverSummary={totalQty:0,totalValue:0,byItem:[],byLocation:[]};

document.addEventListener('DOMContentLoaded', init);

async function init(){
  db=await openDb();
  KtdBridge.init().catch(()=>{});

  bindEvents();
  updateNetworkState();
  window.addEventListener('online',async()=>{
    updateNetworkState();
    KtdBridge.reload();

    await metaSet(OFFLINE_SINCE_KEY,null);
    defer(restoreOrSync,250);
    defer(syncQueue,600);
  });
  window.addEventListener('offline',async()=>{
    updateNetworkState();
    const existing=await metaGet(OFFLINE_SINCE_KEY);
    if(!existing) await metaSet(OFFLINE_SINCE_KEY,new Date().toISOString());
    refreshMySummary(false);
  });

  await ensureDeviceId();
  if(navigator.onLine===false){
    const off=await metaGet(OFFLINE_SINCE_KEY);
    if(!off) await metaSet(OFFLINE_SINCE_KEY,new Date().toISOString());
  }
  const [token,cache]=await Promise.all([metaGet(TOKEN_KEY),metaGet(CACHE_KEY)]);

  if(token && cache){
    enterApp(token,cache,true);
    defer(async()=>{await migrateLegacyQueueOwner(cache.session);},150);
    if(navigator.onLine) {
      defer(restoreOrSync,1100);
      defer(()=>refreshMySummary(true),2500);
    }
  }else{
    showLogin();
  }

  setInterval(()=>{
    updateOfflineMetrics();
    if(navigator.onLine) syncQueue();
  },45000);
  updateOfflineMetrics();
}

function bindEvents(){
  $('#loginBtn').onclick=login;
  $('#logoutBtn').onclick=logout;
  $('#saveBtn').onclick=saveOrder;
  $('#syncBtn').onclick=syncQueue;
  $('#clearCartBtn').onclick=()=>{cart={};renderProducts();renderCart();};
  $('#refreshSummaryBtn').onclick=()=>refreshMySummary(true);

  $$('.payment').forEach(btn=>btn.onclick=()=>{
    payment=btn.dataset.value;
    $$('.payment').forEach(x=>x.classList.toggle('active',x===btn));
  });
}

async function loadVenues(){
  try{
    const res=await server('publicBootstrap');
    venues=res.venues||[];
    await metaSet('venueCache',venues);
  }catch(e){
    venues=await metaGet('venueCache')||[];
  }
  renderVenueSelect();
}

function renderVenueSelect(){
  const staticVenues=[
    {key:'STATIC|Cooltura Semarang|Main Booth',lokasi:'Main Booth',event:'Cooltura Semarang'},
    {key:'STATIC|Cooltura Semarang|Drink Stall 1',lokasi:'Drink Stall 1',event:'Cooltura Semarang'},
    {key:'STATIC|Cooltura Semarang|Drink Stall 2',lokasi:'Drink Stall 2',event:'Cooltura Semarang'},
    {key:'STATIC|Cooltura Semarang|Drink Stall 3',lokasi:'Drink Stall 3',event:'Cooltura Semarang'},
    {key:'STATIC|Cooltura Semarang|Drink Stall 4',lokasi:'Drink Stall 4',event:'Cooltura Semarang'}
  ];
  const map=new Map(staticVenues.map(v=>[v.key,v]));
  (venues||[]).forEach(v=>map.set(v.key,v));
  const all=[...map.values()];
  $('#venue').innerHTML='<option value="">Pilih lokasi venue</option>'+
    all.map(v=>`<option value="${esc(v.key)}">${esc(v.lokasi)} — ${esc(v.event)}</option>`).join('');
}

async function login(){
  if(!navigator.onLine){showMsg('#loginMsg','Login pertama kali memerlukan internet.');return;}
  setButton('#loginBtn',true,'MEMERIKSA...');
  try{
    const res=await server('login',{
      username:$('#username').value,password:$('#password').value,venueKey:$('#venue').value
    });
    await metaSet(TOKEN_KEY,res.token);
    await metaSet(CACHE_KEY,res);
    await metaSet('venueCache',res.venues||[]);
    $('#password').value='';
    enterApp(res.token,res,false);
  }catch(e){showMsg('#loginMsg',e.message||String(e))}
  finally{setButton('#loginBtn',false,'MASUK')}
}

function enterApp(token,res,offlineRestore){
  sessionToken=token||'';
  session=res.session;
  products=res.products||[];
  venues=res.venues||[];
  cart={};

  $('#loginView').classList.add('hidden');
  $('#salesView').classList.remove('hidden');
  $('#userName').textContent=session.namaUser||session.username;
  $('#venueLabel').textContent=`${session.lokasi} • ${session.event}`;

  selectedCategory='ALL';
  renderCategories();
  renderProducts();
  renderCart();
  refreshCounters();
  defer(()=>refreshMySummary(false),180);

  if(!offlineRestore && navigator.onLine) defer(syncQueue,1200);
}

async function restoreOrSync(){
  const token=await metaGet(TOKEN_KEY);
  if(!token){showLogin();renderVenueSelect();return;}

  try{
    const res=await server('restoreSession',token);
    await metaSet(CACHE_KEY,res);
    await migrateLegacyQueueOwner(res.session);

    if($('#salesView').classList.contains('hidden')) enterApp(token,res,false);
    else{
      session=res.session;
      products=res.products||products;
      venues=res.venues||venues;
      renderCategories();renderProducts();renderCart();
      refreshMySummary(false);
    }
    syncQueue();
  }catch(e){
    const msg=(e.message||'').toLowerCase();
    if(msg.includes('session')||msg.includes('aktif')){
      await metaDel(TOKEN_KEY);await metaDel(CACHE_KEY);showLogin();
    }
  }
}

async function logout(){
  const pending=await queueCountForUser(session?.username);
  if(pending>0){
    const ok=confirm(`Ada ${pending} item transaksi Anda belum tersinkron. Logout sekarang? Data tetap tersimpan di HP.`);
    if(!ok)return;
  }
  await metaDel(TOKEN_KEY);await metaDel(CACHE_KEY);
  session=null;sessionToken='';products=[];cart={};serverSummary={totalQty:0,totalValue:0,byItem:[],byLocation:[]};
  $('#salesView').classList.add('hidden');$('#loginView').classList.remove('hidden');renderVenueSelect();
}

function showLogin(){
  $('#salesView').classList.add('hidden');$('#loginView').classList.remove('hidden');
  metaGet('venueCache').then(v=>{venues=v||[];renderVenueSelect();});
}

function renderCategories(){
  const cats=['ALL',...new Set(products.map(p=>p.subKategori||'LAINNYA'))];
  $('#productTabs').innerHTML=cats.map(c=>
    `<button class="category-tab ${c===selectedCategory?'active':''}" data-cat="${esc(c)}">${esc(c==='ALL'?'SEMUA':c)}</button>`
  ).join('');
  $$('.category-tab').forEach(btn=>btn.onclick=()=>{
    selectedCategory=btn.dataset.cat;renderCategories();renderProducts();
  });
}

function renderProducts(){
  const filtered=products.filter(p=>selectedCategory==='ALL'||String(p.subKategori)===selectedCategory);
  $('#productList').innerHTML=filtered.map(p=>{
    const q=Number(cart[p.kodeProduk]||0);
    return `<div class="product-card ${q>0?'in-cart':''}">
      <div><b>${esc(p.namaProduk)}</b><span class="price">${money(p.harga)} / ${esc(p.satuan)}</span></div>
      <div class="product-controls">
        <button data-action="minus" data-code="${esc(p.kodeProduk)}">−</button>
        <strong>${q}</strong>
        <button class="plus" data-action="plus" data-code="${esc(p.kodeProduk)}">+</button>
      </div>
    </div>`;
  }).join('');

  $$('[data-action]').forEach(btn=>btn.onclick=()=>{
    changeCart(btn.dataset.code,btn.dataset.action==='plus'?1:-1);
  });
}

function changeCart(code,delta){
  const next=Math.max(0,Math.min(999,Number(cart[code]||0)+delta));
  if(next===0)delete cart[code];else cart[code]=next;
  renderProducts();renderCart();
  if(navigator.vibrate)navigator.vibrate(12);
}

function renderCart(){
  const lines=products.filter(p=>Number(cart[p.kodeProduk]||0)>0);
  const totalQty=lines.reduce((s,p)=>s+Number(cart[p.kodeProduk]),0);
  const totalValue=lines.reduce((s,p)=>s+Number(cart[p.kodeProduk])*Number(p.harga||0),0);

  $('#cartInfo').textContent=lines.length?`${lines.length} produk • ${totalQty} qty`:'Belum ada item';
  $('#cartList').innerHTML=lines.length?lines.map(p=>{
    const q=Number(cart[p.kodeProduk]);
    return `<div class="cart-row">
      <div><b>${esc(p.namaProduk)}</b><span>${q} × ${money(p.harga)}</span></div>
      <strong>${money(q*Number(p.harga||0))}</strong>
    </div>`;
  }).join(''):'<div class="cart-empty">Pilih satu atau beberapa produk di atas.</div>';

  $('#total').textContent=money(totalValue);
  $('#totalQty').textContent=`${totalQty} qty`;
}

async function saveOrder(){
  if(!session)return;
  const lines=products.filter(p=>Number(cart[p.kodeProduk]||0)>0);
  if(!lines.length){showMsg('#saveMsg','Pilih minimal 1 item.');return;}

  const now=Date.now();
  const orderId=randomId8();
  const deviceId=await metaGet(DEVICE_KEY);
  const note=$('#note').value.trim();

  const records=lines.map((p,i)=>({
    idTransaksi:randomId8(),
    idPesanan:orderId,
    clientTimestamp:now+i,
    kodeProduk:p.kodeProduk,
    namaProduk:p.namaProduk,
    satuan:p.satuan,
    harga:Number(p.harga||0),
    qty:Number(cart[p.kodeProduk]),
    metodePembayaran:payment,
    keterangan:note,
    deviceId,
    createdAt:now+i,
    status:'pending',
    syncStatus:'PENDING',
    ownerUsername:String(session.username||'').toLowerCase(),
    lokasi:session.lokasi,
    event:session.event
  }));

  await queuePutMany(records);
  cart={};$('#note').value='';renderProducts();renderCart();
  showMsg('#saveMsg',navigator.onLine?'Pesanan multi-item tersimpan • menyinkronkan…':'Pesanan multi-item tersimpan OFFLINE di HP.');
  await refreshCounters();await refreshMySummary(false);
  if(navigator.vibrate)navigator.vibrate([25,30,25]);
  if(navigator.onLine)defer(syncQueue,350);
}

async function syncQueue(){
  if(syncInProgress || !session || !navigator.onLine) return;
  syncInProgress=true;

  try{
    let totalSynced=0;

    while(navigator.onLine){
      const pending=await getPendingForUser(session.username,SYNC_BATCH_SIZE);
      if(!pending.length) break;

      // Mark only the current batch as SYNCING.
      for(const row of pending){
        row.syncStatus='SYNCING';
        row.lastSyncAttempt=new Date().toISOString();
        await queuePut(row);
      }
      await refreshCounters();

      let result;
      try{
        result=await server('syncTransactions',{
          token:sessionToken,
          records:pending
        });
      }catch(err){
        // Return rows to PENDING so retry is always possible.
        for(const row of pending){
          row.syncStatus='PENDING';
          row.lastSyncError=String(err && err.message ? err.message : err);
          await queuePut(row);
        }
        await refreshCounters();
        throw err;
      }

      const accepted=new Set([...(result.accepted||[]),...(result.duplicates||[])]);
      for(const row of pending){
        if(accepted.has(row.idTransaksi)){
          await queueDelete(row.idTransaksi);
          totalSynced++;
        }else{
          row.syncStatus='PENDING';
          row.lastSyncError='Server belum mengonfirmasi transaksi.';
          await queuePut(row);
        }
      }

      await metaSet(LAST_SYNC_KEY,new Date().toISOString());
      await refreshCounters();

      // Yield to browser so very large 24h queues don't freeze the UI.
      await new Promise(r=>setTimeout(r,80));
    }

    if(totalSynced>0){
      await loadServerSummary();
      await refreshMySummary(false);
      showMsg('#saveMsg',`${formatNumber(totalSynced)} transaksi berhasil disinkronkan.`);
    }
  }catch(err){
    const detail=String(err && err.message ? err.message : err || 'Unknown sync error');
    console.error('SYNC ERROR:',detail);
    showMsg('#saveMsg','Sync tertunda: '+detail+' • Data tetap aman di HP.',true);
  }finally{
    syncInProgress=false;
    updateOfflineMetrics();
  }
}

async function loadServerSummary(){
  if(!navigator.onLine||!session)return serverSummary;
  try{
    const token=await metaGet(TOKEN_KEY);
    serverSummary=await server('getMySalesSummary',token);
    await metaSet('summary:'+String(session.username).toLowerCase(),serverSummary);
  }catch(e){
    serverSummary=await metaGet('summary:'+String(session.username).toLowerCase())||serverSummary;
  }
  return serverSummary;
}

async function refreshMySummary(forceNetwork=false){
  if(!session)return;

  const cacheKey='summary:'+String(session.username).toLowerCase();
  serverSummary=await metaGet(cacheKey)||serverSummary;

  const offline=await getOfflineSummaryForUser(session.username);
  renderMySummary(mergeSummaries(serverSummary,offline));

  if(forceNetwork && navigator.onLine){
    await loadServerSummary();
    const offlineNow=await getOfflineSummaryForUser(session.username);
    renderMySummary(mergeSummaries(serverSummary,offlineNow));
  }
}

function renderMySummary(merged){
  $('#myTotalQty').textContent=formatNumber(merged.totalQty);
  $('#myTotalValue').textContent=money(merged.totalValue);

  $('#itemSummary').classList.toggle('empty-state',!merged.byItem.length);
  $('#itemSummary').innerHTML=merged.byItem.length?merged.byItem.map(x=>`
    <div class="summary-row">
      <div><b>${esc(x.namaProduk||x.kodeProduk)}</b><small>${esc(x.kodeProduk||'')} ${x.satuan?'• '+esc(x.satuan):''}</small></div>
      <div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div>
    </div>`).join(''):'Belum ada penjualan.';

  $('#locationSummary').classList.toggle('empty-state',!merged.byLocation.length);
  $('#locationSummary').innerHTML=merged.byLocation.length?merged.byLocation.map(x=>`
    <div class="summary-row">
      <div><b>${esc(x.lokasi)}</b><small>Penjualan akun ${esc(session.username)}</small></div>
      <div class="numbers"><strong>${formatNumber(x.qty)} qty</strong><span>${money(x.value)}</span></div>
    </div>`).join(''):'Belum ada penjualan.';
}

function mergeSummaries(a,b){
  const out={totalQty:Number(a?.totalQty||0)+Number(b?.totalQty||0),totalValue:Number(a?.totalValue||0)+Number(b?.totalValue||0),byItem:[],byLocation:[]};
  const im=new Map(),lm=new Map();

  for(const x of[...(a?.byItem||[]),...(b?.byItem||[])]){
    const k=x.kodeProduk||x.namaProduk;
    if(!im.has(k))im.set(k,{kodeProduk:x.kodeProduk,namaProduk:x.namaProduk,satuan:x.satuan,qty:0,value:0});
    const z=im.get(k);z.qty+=Number(x.qty||0);z.value+=Number(x.value||0);
  }
  for(const x of[...(a?.byLocation||[]),...(b?.byLocation||[])]){
    const k=x.lokasi||'Tanpa Lokasi';
    if(!lm.has(k))lm.set(k,{lokasi:k,qty:0,value:0});
    const z=lm.get(k);z.qty+=Number(x.qty||0);z.value+=Number(x.value||0);
  }
  out.byItem=[...im.values()].sort((x,y)=>String(x.namaProduk).localeCompare(String(y.namaProduk)));
  out.byLocation=[...lm.values()].sort((x,y)=>String(x.lokasi).localeCompare(String(y.lokasi)));
  return out;
}

async function getOfflineSummaryForUser(username){
  const uname=String(username||'').toLowerCase();
  const all=await getAllQueue();
  const mine=all.filter(x=>String(x.ownerUsername||'').toLowerCase()===uname && x.status!=='error');
  const out={totalQty:0,totalValue:0,byItem:[],byLocation:[]},im=new Map(),lm=new Map();

  for(const x of mine){
    const p=products.find(p=>String(p.kodeProduk)===String(x.kodeProduk));
    const qty=Number(x.qty||0);
    const price=Number(x.harga ?? p?.harga ?? 0);
    const value=qty*price;
    const kode=x.kodeProduk||'',nama=x.namaProduk||p?.namaProduk||kode,satuan=x.satuan||p?.satuan||'',loc=x.lokasi||session?.lokasi||'Tanpa Lokasi';
    out.totalQty+=qty;out.totalValue+=value;

    if(!im.has(kode))im.set(kode,{kodeProduk:kode,namaProduk:nama,satuan,qty:0,value:0});
    im.get(kode).qty+=qty;im.get(kode).value+=value;
    if(!lm.has(loc))lm.set(loc,{lokasi:loc,qty:0,value:0});
    lm.get(loc).qty+=qty;lm.get(loc).value+=value;
  }
  out.byItem=[...im.values()];out.byLocation=[...lm.values()];
  return out;
}

function updateNetworkState(){
  const online=navigator.onLine;$('#offlineBar').classList.toggle('hidden',online);
  if($('#netStatus'))$('#netStatus').textContent=syncing?'SYNCING...':(online?'ONLINE':'OFFLINE');
}

async function refreshCounters(){
  if(!session)return;
  const pending=await queueCountForUser(session.username);
  $('#pendingCount').textContent=pending;$('#pendingChip').textContent=`${pending} PENDING`;
  const d=new Date();d.setHours(0,0,0,0);
  $('#todayCount').textContent=await queueCountSinceForUser(d.getTime(),session.username);
  updateOfflineMetrics();
}

// ---------- IndexedDB ----------
function openDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      if(!d.objectStoreNames.contains(Q_STORE)){
        const s=d.createObjectStore(Q_STORE,{keyPath:'idTransaksi'});
        s.createIndex('createdAt','createdAt',{unique:false});s.createIndex('status','status',{unique:false});
      }
      if(!d.objectStoreNames.contains(META_STORE))d.createObjectStore(META_STORE,{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name)}
function reqP(req){return new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error)})}
function queueDelete(id){return reqP(store(Q_STORE,'readwrite').delete(id))}
function getAllQueue(){return reqP(store(Q_STORE).getAll())}

function queuePut(item){
  return reqP(store(Q_STORE,'readwrite').put(item));
}

function queuePutMany(items){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(Q_STORE,'readwrite'),s=tx.objectStore(Q_STORE);
    items.forEach(x=>s.put(x));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  });
}
async function queueCountForUser(username){
  const u=String(username||'').toLowerCase(),all=await getAllQueue();
  return all.filter(x=>String(x.ownerUsername||'').toLowerCase()===u && x.status!=='error').length;
}
async function queueCountSinceForUser(ts,username){
  const u=String(username||'').toLowerCase(),all=await getAllQueue();
  return all.filter(x=>String(x.ownerUsername||'').toLowerCase()===u && Number(x.createdAt)>=ts && x.status!=='error').length;
}
async function queueAll(){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('queue','readonly');
    const req=tx.objectStore('queue').getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}

async function getPendingForUser(username,limit=SYNC_BATCH_SIZE){
  const u=String(username||'').toLowerCase();
  const all=await getAllQueue();
  return all
    .filter(x=>{
      const same=String(x.ownerUsername||'').toLowerCase()===u;
      const localStatus=String(x.status||'pending').toLowerCase();
      const syncStatus=String(x.syncStatus||'PENDING').toUpperCase();
      return same && localStatus!=='error' && (syncStatus==='PENDING' || syncStatus==='SYNCING');
    })
    .sort((a,b)=>Number(a.createdAt||0)-Number(b.createdAt||0))
    .slice(0,limit)
    .map(x=>{
      // leftover SYNCING after browser crash can safely retry
      if(String(x.syncStatus||'').toUpperCase()==='SYNCING') x.syncStatus='PENDING';
      return x;
    });
}
async function queueMarkError(id,error){
  const s=store(Q_STORE,'readwrite'),item=await reqP(s.get(id));
  if(item){item.status='error';item.error=String(error||'Unknown error');await reqP(s.put(item))}
}
async function migrateLegacyQueueOwner(cachedSession){
  const owner=String(cachedSession?.username||'').toLowerCase();if(!owner)return;
  const all=await getAllQueue(),legacy=all.filter(x=>!x.ownerUsername);
  if(!legacy.length)return;
  legacy.forEach(x=>{
    x.ownerUsername=owner;
    x.lokasi=x.lokasi||cachedSession.lokasi||'';
    x.event=x.event||cachedSession.event||'';
    const p=products.find(p=>String(p.kodeProduk)===String(x.kodeProduk));
    if(p){x.namaProduk=x.namaProduk||p.namaProduk;x.satuan=x.satuan||p.satuan;x.harga=Number(x.harga??p.harga??0)}
  });
  await queuePutMany(legacy);
}

async function metaGet(key){const v=await reqP(store(META_STORE).get(key));return v?v.value:null}
function metaSet(key,value){return reqP(store(META_STORE,'readwrite').put({key,value}))}
function metaDel(key){return reqP(store(META_STORE,'readwrite').delete(key))}
async function ensureDeviceId(){let id=await metaGet(DEVICE_KEY);if(!id){id='DEV-'+randomId8()+randomId8();await metaSet(DEVICE_KEY,id)}return id}


async function testServerConnection(){
  if(!navigator.onLine) return {ok:false,error:'Browser mendeteksi OFFLINE'};
  try{
    const res=await server('getDatabaseInfo');
    console.log('SERVER CONNECTION OK',res);
    return {ok:true,data:res};
  }catch(e){
    console.error('SERVER CONNECTION FAILED',e);
    return {ok:false,error:e.message||String(e)};
  }
}

// ---------- Apps Script ----------
function server(name,payload){
  return KtdBridge.call(name,payload);
}

function formatDuration(ms){
  ms=Math.max(0,Number(ms)||0);
  const h=Math.floor(ms/3600000);
  const m=Math.floor((ms%3600000)/60000);
  if(h>0) return `${h}j ${m}m`;
  return `${m}m`;
}

async function updateOfflineMetrics(){
  const pendingEl=document.querySelector('#pendingCount');
  const offlineEl=document.querySelector('#offlineDuration');
  const lastSyncEl=document.querySelector('#lastSyncAt');

  if(session && pendingEl){
    const all=await queueAll();
    const own=all.filter(r=>String(r.ownerUsername||'').toLowerCase()===String(session.username||'').toLowerCase());
    pendingEl.textContent=formatNumber(own.length);

    if(own.length>=MAX_LOCAL_QUEUE_WARNING){
      showMsg('#saveMsg',`Perhatian: ${formatNumber(own.length)} transaksi masih tersimpan lokal. Sambungkan internet dan lakukan sync secepatnya.`,true);
    }
  }

  if(offlineEl){
    const since=await metaGet(OFFLINE_SINCE_KEY);
    offlineEl.textContent=(!navigator.onLine && since)
      ? formatDuration(Date.now()-new Date(since).getTime())
      : '0m';
  }

  if(lastSyncEl){
    const last=await metaGet(LAST_SYNC_KEY);
    lastSyncEl.textContent=last ? new Date(last).toLocaleString('id-ID') : 'Belum pernah';
  }
}

// ---------- Helpers ----------
function defer(fn,ms=0){
  if('requestIdleCallback' in window){
    requestIdleCallback(()=>Promise.resolve(fn()).catch(console.warn),{timeout:Math.max(500,ms+500)});
  }else{
    setTimeout(()=>Promise.resolve(fn()).catch(console.warn),ms);
  }
}

function randomId8(){let raw;if(window.crypto&&crypto.randomUUID)raw=crypto.randomUUID().replace(/-/g,'');else raw=(Date.now().toString(16)+Math.random().toString(16).slice(2));return raw.slice(0,8).toUpperCase()}
function money(n){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(Number(n)||0)}
function formatNumber(n){return new Intl.NumberFormat('id-ID').format(Number(n)||0)}
function $(s){return document.querySelector(s)} function $$(s){return [...document.querySelectorAll(s)]}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function showMsg(sel,text){const e=$(sel);if(!e)return;e.textContent=text||'';setTimeout(()=>{if(e.textContent===text)e.textContent=''},4500)}
function setButton(sel,disabled,text){const e=$(sel);e.disabled=disabled;e.textContent=text}
