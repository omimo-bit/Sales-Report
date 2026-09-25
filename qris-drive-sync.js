
/*
 * KTD QRIS DRIVE SYNC V3
 * ======================================================
 * Dependency:
 * - QrisPhotoVault V2 sudah terpasang
 * - KtdBridge.call()
 *
 * Module ini:
 * - membuat nama file:
 *   NamaSPG__Produk__Nominal__HH-MM-SS__OrderID.jpg
 * - upload foto local-vault ke Google Drive
 * - retry saat online kembali
 * - tidak menghapus copy lokal setelah upload
 */

const QrisDriveSync = (() => {
  const SYNC_INTERVAL_MS = 45_000;
  const MAX_BASE64_BYTES = 1_800_000;

  let getContext = null;
  let getSessionToken = null;
  let syncRunning = false;

  function cleanPart(value, maxLen=50) {
    return String(value || '')
      .trim()
      .replace(/[\\/:*?"<>|#%{}\[\]~]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen) || 'NA';
  }

  function rupiahNumber(value) {
    return 'Rp' + Math.round(Number(value || 0));
  }

  function timePart(dateInput) {
    const date = new Date(dateInput || Date.now());

    return [
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
      String(date.getSeconds()).padStart(2, '0')
    ].join('-');
  }

  function dateKey(dateInput) {
    const date = new Date(dateInput || Date.now());

    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  function productPart(items) {
    const names = (items || [])
      .map(item => String(item.namaProduk || item.name || '').trim())
      .filter(Boolean);

    if (!names.length) return 'Produk';

    const cleaned = names
      .map(name => cleanPart(name, 42));

    // Supaya nama file tidak terlalu panjang.
    if (cleaned.length <= 2) {
      return cleaned.join('+');
    }

    return (
      cleaned.slice(0, 2).join('+') +
      `+${cleaned.length - 2}ITEM`
    );
  }

  function makeFileName(meta) {
    const spg =
      cleanPart(
        meta.namaUser ||
        meta.username ||
        'SPG',
        35
      );

    const products =
      productPart(meta.items);

    const nominal =
      rupiahNumber(meta.totalValue);

    const jam =
      timePart(meta.createdAt);

    const order =
      cleanPart(meta.orderId, 45);

    return (
      `${spg}__${products}__${nominal}` +
      `__${jam}__${order}.jpg`
    );
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();

    if (buffer.byteLength > MAX_BASE64_BYTES) {
      throw new Error(
        'Foto masih terlalu besar untuk upload Drive.'
      );
    }

    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(
        ...bytes.subarray(
          i,
          Math.min(i + chunk, bytes.length)
        )
      );
    }

    return btoa(binary);
  }

  async function uploadRecord(record, meta) {
    if (!navigator.onLine) {
      return {
        ok: false,
        offline: true
      };
    }

    const token =
      String(
        getSessionToken
          ? await getSessionToken()
          : ''
      );

    if (!token) {
      throw new Error(
        'Session token tidak tersedia.'
      );
    }

    const fileName =
      makeFileName(meta);

    const base64 =
      await blobToBase64(record.blob);

    const result =
      await KtdBridge.call(
        'uploadQrisPhoto',
        {
          token,
          orderId: meta.orderId,
          username: meta.username,
          namaUser: meta.namaUser,
          event: meta.event,
          lokasi: meta.venue,
          dateKey: dateKey(meta.createdAt),
          fileName,
          base64
        }
      );

    return {
      ...result,
      fileName
    };
  }

  async function uploadCurrentOrder(params) {
    /*
     * params:
     * {
     *   record: vaultRecord,
     *   orderId,
     *   username,
     *   namaUser,
     *   event,
     *   venue,
     *   items:[{namaProduk}],
     *   totalValue,
     *   createdAt
     * }
     */

    if (!params?.record?.blob) {
      throw new Error(
        'Foto QRIS lokal tidak tersedia.'
      );
    }

    const result =
      await uploadRecord(
        params.record,
        params
      );

    return result;
  }

  async function init(options={}) {
    getContext =
      typeof options.getContext === 'function'
        ? options.getContext
        : null;

    getSessionToken =
      typeof options.getSessionToken === 'function'
        ? options.getSessionToken
        : null;

    window.addEventListener(
      'online',
      () => {
        // Retry global dikelola integrasi app/vault.
        document.dispatchEvent(
          new CustomEvent(
            'ktd:qris-drive-online'
          )
        );
      }
    );
  }

  return {
    init,
    makeFileName,
    uploadCurrentOrder
  };
})();
