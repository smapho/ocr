const fileInput = document.getElementById('fileInput');
const drop = document.getElementById('drop');
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

let selectedFiles = [];

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

function isImageFile(file) {
  if (file.type.startsWith('image/')) return true;
  // HEIC/HEIFはブラウザ・OSによって type が空文字になることがあるため拡張子でも判定する
  return /\.(heic|heif)$/i.test(file.name);
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

function handleFiles(fileListInput) {
  selectedFiles = Array.from(fileListInput).filter(isImageFile);
  renderFileList();
  ingestBtn.disabled = selectedFiles.length === 0;
}

function renderFileList() {
  fileList.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.id = `file-row-${i}`;
    row.innerHTML = `
      <span class="name">${file.name}</span>
      <span class="badge pending" id="file-badge-${i}">待機中</span>
      <span class="file-error" id="file-error-${i}"></span>
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

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// アップロード用データを準備する。
// HEIC/HEIFはブラウザのcanvasで直接デコードできず変換ライブラリも一部の
// バリエーション(HDR gain map付きなど)に対応できないため、変換せず
// 生のまま送る(Gemini APIはimage/heic・image/heifをネイティブにサポートしている)。
// それ以外の画像は最大辺 MAX_DIMENSION に縮小してJPEG化し、転送量を減らす。
async function prepareUpload(file) {
  if (isHeic(file)) {
    const mimeType = /\.heif$/i.test(file.name) ? 'image/heif' : 'image/heic';
    return { mimeType, imageBase64: await readAsBase64(file) };
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
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        resolve({ mimeType: 'image/jpeg', imageBase64: dataUrl.split(',')[1] });
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

async function processOne(i) {
  const file = selectedFiles[i];
  setFileStatus(i, 'processing', '処理中');
  try {
    const { mimeType, imageBase64 } = await prepareUpload(file);
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType, imageBase64 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '取り込みに失敗しました');
    setFileStatus(i, 'done', '完了');
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

async function loadDocuments() {
  const res = await fetch('/api/documents');
  const json = await res.json();
  const docs = json.documents || [];
  docTableBody.innerHTML = '';
  emptyMsg.style.display = docs.length === 0 ? 'block' : 'none';

  docs.forEach((doc) => {
    const tr = document.createElement('tr');
    const maskedNote = doc.inspection_amount_masked
      ? '<span class="masked">(マスクのため事前承認金額を採用)</span>'
      : '';
    tr.innerHTML = `
      <td>${doc.image_url ? `<img class="thumb" src="${doc.image_url}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb-fallback',textContent:'📄'}))" />` : '-'}</td>
      <td>${doc.target_period || '-'}</td>
      <td>${doc.vendor_name || '-'}</td>
      <td>${doc.expense_item_name || '-'}</td>
      <td>${yen(doc.pre_approved_amount)}</td>
      <td>${yen(doc.inspection_amount)}${maskedNote}</td>
      <td>${doc.change_reason || '-'}</td>
      <td>${doc.approval_no || '-'}</td>
    `;
    docTableBody.appendChild(tr);
  });
}

loadDocuments();
