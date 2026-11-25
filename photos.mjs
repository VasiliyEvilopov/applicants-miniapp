import {Zip, ZipPassThrough} from './fflate-0.8.3.mjs';

export function archiveCount(selected, copies) {
  if (!Number.isSafeInteger(copies) || copies < 1) throw Error('Введите целое число копий от 1.');
  const total = selected * copies;
  if (!Number.isSafeInteger(total) || total > 65535) throw Error('В одном ZIP может быть не больше 65535 файлов.');
  return total;
}

async function preparePhoto(file, maxSize) {
  if (!maxSize) return {bytes: new Uint8Array(await file.arrayBuffer()), extension: {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[file.type]};
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw Error('Браузер не поддерживает обработку фотографий.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw Error('Не удалось сохранить фотографию.');
    return {bytes: new Uint8Array(await blob.arrayBuffer()), extension:'jpg'};
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}

export async function createPhotoArchive(files, copies, maxSize, onProgress = () => {}) {
  const total = archiveCount(files.length, copies);
  if (!total) throw Error('Сначала выберите фотографии.');
  if (![0, 256, 512, 1024].includes(maxSize)) throw Error('Выберите доступный размер.');
  const chunks = [];
  let failure;
  const zip = new Zip((error, chunk) => { if (error) failure = error; else chunks.push(chunk); });
  try {
    let count = 0;
    for (let index = 0; index < files.length; index++) {
      const {bytes, extension} = await preparePhoto(files[index], maxSize);
      if (!extension) throw Error('Поддерживаются только JPEG, PNG и WebP.');
      for (let copy = 0; copy < copies; copy++) {
        const entry = new ZipPassThrough(`photo-${String(index + 1).padStart(4,'0')}-copy-${String(copy + 1).padStart(4,'0')}.${extension}`);
        zip.add(entry);
        entry.push(bytes, true);
        if (failure) throw failure;
        count++;
      }
      onProgress(count, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    zip.end();
    if (failure) throw failure;
    return new Blob(chunks, {type:'application/zip'});
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export function setupPhotos() {
  const get = id => document.getElementById(`photos-${id}`);
  const items = [];
  let archiveUrl = '', busy = false;
  function invalidate() {
    if (archiveUrl) URL.revokeObjectURL(archiveUrl);
    archiveUrl = '';
    get('download').hidden = true;
    get('download').removeAttribute('href');
  }
  function update() {
    const count = items.filter(item => item.checkbox.checked).length;
    get('selected-count').textContent = `Выбрано: ${count} из ${items.length}`;
    let valid = true;
    try { get('summary').textContent = `В ZIP будет файлов: ${archiveCount(count, Number(get('copies').value))}. Только указанное число копий, без дополнительных оригиналов.`; }
    catch(error) { valid = false; get('summary').textContent = error.message; }
    get('build').disabled = busy || !count || !valid;
    for (const id of ['files','pick','clear','count','copies','size']) get(id).disabled = busy;
    items.forEach(item => item.checkbox.disabled = busy);
  }
  get('files').onchange = () => {
    invalidate();
    let skipped = 0;
    for (const file of get('files').files) {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { skipped++; continue; }
      const url = URL.createObjectURL(file);
      const card = document.createElement('label'); card.className = 'vk-avatar vk-avatar-preview';
      const image = document.createElement('img'); image.src = url; image.alt = file.name; image.loading = 'lazy';
      const label = document.createElement('span'); label.className = 'vk-avatar-select';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `Выбрать ${file.name}`);
      checkbox.onchange = () => { invalidate(); update(); };
      label.append(checkbox, document.createTextNode('Выбрать'));
      card.append(image, label);
      get('results').append(card);
      items.push({file, url, checkbox});
    }
    get('files').value = '';
    get('status').textContent = skipped ? `Пропущено файлов неподдерживаемого формата: ${skipped}.` : '';
    update();
  };
  get('pick').onclick = () => {
    const count = Number(get('count').value);
    if (!Number.isSafeInteger(count) || count < 1) { get('status').textContent = 'Введите целое количество от 1.'; return; }
    invalidate();
    items.forEach((item, index) => item.checkbox.checked = index < count);
    get('status').textContent = `Выбрано ${Math.min(count, items.length)} фото по порядку загрузки.`;
    update();
  };
  get('clear').onclick = () => { invalidate(); items.forEach(item => item.checkbox.checked = false); update(); };
  for (const id of ['copies','size']) get(id).oninput = () => { invalidate(); update(); };
  get('build').onclick = async () => {
    if (busy) return;
    invalidate(); busy = true; update();
    try {
      const blob = await createPhotoArchive(items.filter(item => item.checkbox.checked).map(item => item.file), Number(get('copies').value), Number(get('size').value), (done,total) => get('status').textContent = `Собираем ZIP: ${done} из ${total}…`);
      archiveUrl = URL.createObjectURL(blob);
      get('download').href = archiveUrl;
      get('download').download = `my-photos-${Date.now()}.zip`;
      get('download').hidden = false;
      get('status').textContent = 'Архив готов. Нажмите «Скачать ZIP».';
    } catch(error) { get('status').textContent = `Не удалось собрать архив: ${error.message}`; }
    finally { busy = false; update(); }
  };
  update();
}
