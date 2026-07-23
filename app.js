import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 公開して問題ない値(publishableキー)。署名付きアップロードURLの実行にのみ使う。
const SUPABASE_URL = 'https://nfpqqcqlcgegjuptmwiw.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jPwnFWwg6oP9CmiMVN9IHA_yR0_Ts-g';
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const PROCESSED_DIR_NAME = '取り込み済み';

const fileInput = document.getElementById('fileInput');
const drop = document.getElementById('drop');
const dirPickBtn = document.getElementById('dirPickBtn');
const dirSupportNote = document.getElementById('dirSupportNote');
const fileList = document.getElementById('fileList');
const ingestBtn = document.getElementById('ingestBtn');
const docTableBody = document.getElementById('docTableBody');
const emptyMsg = document.getElementById('emptyMsg');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

const MAX_DIMENSION = 1800;
const JPEG_QUALITY = 0.85;
// 同時に処理するファイル数。増やすほど速いがGemini/Supabaseへの同時リクエストが増える
const CONCURRENCY = 4;

// { file: File, handle: FileSystemFileHandle|null }[]
// handle があるものはフォルダ選択経由で読み込まれたファイルで、成功後に自動移動できる。
let selectedFiles = [];
let sourceDirHandle = null;

const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function';
if (!supportsDirectoryPicker) {
  dirPickBtn.disabled = true;
  dirSupportNote.textContent = 'このブラウザは未対応です(Chrome/Edgeでご利用ください)';
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  sourceDirHandle = null;
  setFilesFromFileList(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  sourceDirHandle = null;
  setFilesFromFileList(fileInput.files);
});

dirPickBtn.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && isImageName(name)) {
        entries.push({ file: await handle.getFile(), handle });
      }
    }
    sourceDirHandle = dirHandle;
    selectedFiles = entries;
    renderFileList();
    ingestBtn.disabled = selectedFiles.length === 0;
  } catch (err) {
    // ユーザーがダイアログをキャンセルした場合などは何もしない
    if (err.name !== 'AbortError') console.error(err);
  }
});

function isImageName(name) {
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
}

function isImageFile(file) {
  if (file.type.startsWith('image/')) return true;
  return isImageName(file.name);
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

function setFilesFromFileList(fileListInput) {
  selectedFiles = Array.from(fileListInput)
    .filter(isImageFile)
    .map((file) => ({ file, handle: null }));
  renderFileList();
  ingestBtn.disabled = selectedFiles.length === 0;
}

function renderFileList() {
  fileList.innerHTML = '';
  selectedFiles.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.id = `file-row-${i}`;
    row.innerHTML = `
      <span class="name">${entry.file.name}</span>
      <span class="badge pending" id="file-badge-${i}">待機中</span>
      <span class="file-error" id="file-error-${i}"></span>
      <span class="file-note" id="file-note-${i}"></span>
    `;
    fileList.appendChild(row);
  });
}

function setFileStatus(i, status, label, errorDetail) {
  const badge = document.getElementById(`file-badge-${i}`);
  if (badge) {
    badge.className = `badge ${status}`;
    badge.textContent = label;
  }
  const errorEl = document.getElementById(`file-error-${i}`);
  if (errorEl) errorEl.textContent = errorDetail || '';
}

function setFileNote(i, note) {
  const noteEl = document.getElementById(`file-note-${i}`);
  if (noteEl) noteEl.textContent = note || '';
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// アップロード用のファイル本体(Blob)とmimeTypeを準備する。
// HEIC/HEIFはブラウザのcanvasで直接デコードできず変換ライブラリも一部の
// バリエーション(HDR gain map付きなど)に対応できないため、変換せず
// 生のまま送る(Gemini APIはimage/heic・image/heifをネイティブにサポートしている)。
// それ以外の画像は最大辺 MAX_DIMENSION に縮小してJPEG化し、転送量を減らす。
async function prepareUpload(file) {
  if (isHeic(file)) {
    const mimeType = /\.heif$/i.test(file.name) ? 'image/heif' : 'image/heic';
    return { mimeType, blob: file };
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => resolve({ mimeType: 'image/jpeg', blob }), 'image/jpeg', JPEG_QUALITY);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function updateProgress(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${done} / ${total} 完了 (${pct}%)`;
}

// 処理が終わった元ファイルを、選択元フォルダ内の「取り込み済み」サブフォルダへ移動する。
// フォルダ選択(File System Access API)経由の場合のみ実行可能。
async function moveToProcessedFolder(name) {
  if (!sourceDirHandle) return false;
  const processedDir = await sourceDirHandle.getDirectoryHandle(PROCESSED_DIR_NAME, { create: true });
  const srcHandle = await sourceDirHandle.getFileHandle(name);
  const file = await srcHandle.getFile();
  const destName = `${Date.now()}_${name}`;
  const destHandle = await processedDir.getFileHandle(destName, { create: true });
  const writable = await destHandle.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
  await sourceDirHandle.removeEntry(name);
  return true;
}

async function processOne(i) {
  const { file, handle } = selectedFiles[i];
  setFileStatus(i, 'processing', '処理中');
  try {
    const { mimeType, blob } = await prepareUpload(file);

    const urlRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name }),
    });
    const urlJson = await urlRes.json();
    if (!urlRes.ok) throw new Error(urlJson.error || 'アップロードURLの発行に失敗しました');
    const { storagePath, token } = urlJson;

    const { error: uploadError } = await supabaseClient.storage
      .from('ocr-images')
      .uploadToSignedUrl(storagePath, token, blob, { contentType: mimeType });
    if (uploadError) throw new Error(`アップロードに失敗しました: ${uploadError.message}`);

    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType, storagePath }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '取り込みに失敗しました');
    setFileStatus(i, 'done', '完了');

    if (handle) {
      try {
        await moveToProcessedFolder(file.name);
        setFileNote(i, `「${PROCESSED_DIR_NAME}」フォルダへ移動しました`);
      } catch (moveErr) {
        console.error(moveErr);
        setFileNote(i, 'データは格納済みですが、フォルダの移動に失敗しました');
      }
    }
  } catch (err) {
    console.error(err);
    setFileStatus(i, 'error', 'エラー', err.message || String(err));
  }
}

// 最大 CONCURRENCY 件を同時に処理するワーカープール。
// 1件ずつ順番に待つより大幅に速くなる。
async function runPool(total, worker) {
  let next = 0;
  let done = 0;
  updateProgress(0, total);

  async function runWorker() {
    while (next < total) {
      const i = next++;
      await worker(i);
      done++;
      updateProgress(done, total);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, runWorker);
  await Promise.all(workers);
}

ingestBtn.addEventListener('click', async () => {
  ingestBtn.disabled = true;
  progressWrap.style.display = 'block';
  await runPool(selectedFiles.length, processOne);
  await loadDocuments();
  ingestBtn.disabled = false;
});

function yen(n) {
  if (n === null || n === undefined) return '-';
  return `¥${Number(n).toLocaleString('ja-JP')}`;
}

function percent(n) {
  return n === null || n === undefined ? '-' : `${n}%`;
}

function codeSummary(doc) {
  const codes = [doc.company_code, doc.division_code, doc.branch_code, doc.store_code].filter(
    (c) => c !== null && c !== undefined && c !== ''
  );
  return codes.length ? codes.join('-') : '-';
}

function formatDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function deleteDocument(id) {
  const res = await fetch(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '削除に失敗しました');
}

async function loadDocuments() {
  const res = await fetch('/api/documents');
  const json = await res.json();
  const docs = json.documents || [];
  docTableBody.innerHTML = '';
  emptyMsg.style.display = docs.length === 0 ? 'block' : 'none';

  docs.forEach((doc) => {
    const tr = document.createElement('tr');
    const maskedNote = doc.inspection_amount_masked
      ? '<span class="masked">(定額)</span>'
      : '';
    if (doc.image_url) {
      tr.classList.add('clickable-row');
      tr.title = '画像を新しいタブで開く';
      tr.addEventListener('click', () => window.open(doc.image_url, '_blank', 'noopener'));
    }
    tr.innerHTML = `
      <td>${codeSummary(doc)}</td>
      <td>${doc.target_period || '-'}</td>
      <td>${doc.vendor_name || '-'}</td>
      <td>${doc.expense_item_name || '-'}</td>
      <td>${yen(doc.pre_approved_amount)}</td>
      <td>${yen(doc.inspection_amount)}${maskedNote}</td>
      <td>${percent(doc.tax_rate)}</td>
      <td>${doc.inspection_date || '-'}</td>
      <td>${doc.payment_due_date || '-'}</td>
      <td>${doc.payment_method || '-'}</td>
      <td>${doc.remittance_form ?? '-'}</td>
      <td>${doc.change_reason || '-'}</td>
      <td>${doc.approval_no || '-'}</td>
      <td>${formatDateTime(doc.created_at)}</td>
      <td><button type="button" class="delete-btn" data-id="${doc.id}">削除</button></td>
    `;
    const deleteBtn = tr.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('このデータを削除しますか?(元画像も削除されます)')) return;
      deleteBtn.disabled = true;
      try {
        await deleteDocument(doc.id);
        await loadDocuments();
      } catch (err) {
        console.error(err);
        window.alert(err.message || '削除に失敗しました');
        deleteBtn.disabled = false;
      }
    });
    docTableBody.appendChild(tr);
  });
}

loadDocuments();
