import {take} from './core.mjs?v=3';

/* Personal storage: GitHub serves code; contact data stays in the browser or Telegram. */
export const EMPTY = () => ({stock: [], issued: []});
const ROOT = 'applicants_v1';
const CHUNK_SIZE = 3000;
const MAX_CHUNKS = 250;
export function validate(value) {
  if (!value || !Array.isArray(value.stock) || !Array.isArray(value.issued)) throw Error('Нужен файл sklad.json из ApplicantsTools.');
  const data = structuredClone(value), ids = new Set();
  const items = x => { if (!Array.isArray(x) || x.some(s => typeof s !== 'string' || !s.trim() || s.length > 4096)) throw Error('Некорректный список контактов.'); };
  const meta = (x, field) => {
    if (!x || typeof x !== 'object') throw Error('Некорректная запись.');
    x.id ||= crypto.randomUUID();
    if (typeof x.id !== 'string' || ids.has(x.id)) throw Error('Повторяющийся ID.');
    ids.add(x.id);
    x[field] ??= 0;
    if (!Number.isFinite(x[field])) throw Error('Некорректная дата.');
  };
  for (const b of data.stock) {
    meta(b, 'createdAt'); items(b.items); b.kind ||= 'mixed';
    if (!['u','p','mixed'].includes(b.kind)) throw Error('Неизвестный тип партии.');
    b.name = String(b.name || 'Без названия').slice(0,60);
    b.total = Math.max(b.items.length, Number(b.total) || b.items.length);
  }
  for (const t of data.issued) {
    meta(t, 'takenAt');
    if (t.items && !t.users) {
      items(t.items);
      t.users = t.items.filter(s => !/^\+?[\d\s()\-]{7,}$/.test(s));
      t.phones = t.items.filter(s => /^\+?[\d\s()\-]{7,}$/.test(s));
      delete t.items;
    }
    items(t.users); items(t.phones);
  }
  return {stock:data.stock, issued:data.issued};
}
export function callCloud(api, method, ...args) {
  return new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(Error('Telegram не ответил. Проверьте соединение и повторите.')), 20000);
    api[method](...args, (error, result) => { clearTimeout(timeout); if (error || result === false) reject(Error(error ? String(error) : 'Telegram не сохранил изменения.'));
      else resolve(result); });
  });
}
async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function encodeSnapshot(text) {
  if (text.length <= CHUNK_SIZE || typeof CompressionStream !== 'function' ||
      typeof DecompressionStream !== 'function') {
    return {payload: text, encoding: 'json'};
  }

  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const payload = btoa(binary);
  return payload.length < text.length
    ? {payload, encoding: 'gzip'}
    : {payload: text, encoding: 'json'};
}

async function decodeSnapshot(payload, encoding) {
  if (encoding !== 'gzip') return payload;
  if (typeof DecompressionStream !== 'function') {
    throw Error('Обновите Telegram или откройте склад на другом устройстве для чтения сжатых данных.');
  }

  const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function chunkKeys(manifest) {
  if (!manifest) return [];
  return Array.from({length: manifest.count}, (_, i) => `${ROOT}_${manifest.gen}_${i}`);
}

export class CloudStore {
  constructor(api) {
    this.api = api;
    this.revision = undefined;
    this.label = 'Облако Telegram';
  }

  async load(attempt = 0) {
    const raw = await callCloud(this.api, 'getItem', ROOT);
    if (!raw) {
      this.revision = '';
      return EMPTY();
    }

    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      throw Error('Не удалось прочитать облачный склад. Не перезаписывайте его.');
    }
    const journal = manifest?.v === 3 && Array.isArray(manifest.issues) &&
      ['json', 'gzip'].includes(manifest.encoding);
    const supported = journal || manifest?.v === 1 || (manifest?.v === 2 && manifest.encoding === 'gzip');
    if (!supported || !/^[a-z0-9_-]+$/.test(manifest.gen) ||
        !Number.isInteger(manifest.count) || manifest.count < 1 || manifest.count > MAX_CHUNKS) {
      throw Error('Повреждена запись облачного склада.');
    }

    const keys = chunkKeys(manifest);
    const values = {};
    for (let i = 0; i < keys.length; i += 64) {
      Object.assign(values, await callCloud(this.api, 'getItems', keys.slice(i, i + 64)));
    }
    if (keys.some(key => typeof values[key] !== 'string' || !values[key])) {
      if (attempt < 2 && await callCloud(this.api, 'getItem', ROOT) !== raw) return this.load(attempt + 1);
      throw Error('Склад загрузился не полностью. Повторите открытие.');
    }

    const payload = keys.map(key => values[key]).join('');
    if (await digest(payload) !== manifest.hash) throw Error('Не прошла проверка целостности склада.');
    const text = await decodeSnapshot(payload, manifest.encoding ?? 'json');
    const data = validate(JSON.parse(text));
    if (journal) {
      for (const {users, phones, batchId, id, takenAt} of manifest.issues) {
        take(data, users, phones, batchId, {id, takenAt});
      }
    }
    this.revision = raw;
    return data;
  }

  async cleanOldChunks(previousKeys) {
    const revision = await callCloud(this.api, 'getItem', ROOT);
    const active = new Set(chunkKeys(revision ? JSON.parse(revision) : null));
    const keys = await callCloud(this.api, 'getKeys');
    const obsolete = new Set(previousKeys.filter(key => !active.has(key)));
    for (const key of keys) {
      if (active.has(key) || !key.startsWith(ROOT + '_')) continue;
      const stamp = parseInt(key.slice(ROOT.length + 1).split('-')[0], 36);
      if (Number.isFinite(stamp) && stamp < Date.now() - 3600000) obsolete.add(key);
    }
    const obsoleteKeys = [...obsolete];
    for (let i = 0; i < obsoleteKeys.length; i += 64) {
      await callCloud(this.api, 'removeItems', obsoleteKeys.slice(i, i + 64));
    }
  }

  async saveIssue(data, operation) {
    if (!this.revision) return this.save(data);

    const revision = this.revision;
    const previous = JSON.parse(revision);
    const next = JSON.stringify({
      ...previous,
      v: 3,
      encoding: previous.encoding ?? 'json',
      issues: [...(previous.issues ?? []), operation],
    });
    // Telegram limits each value to 4096 characters. A full save compacts the journal.
    if (next.length > 4000) return this.save(data);

    if (await callCloud(this.api, 'getItem', ROOT) !== revision) {
      throw Error('Склад изменён на другом устройстве. Обновите данные перед продолжением.');
    }

    await callCloud(this.api, 'setItem', ROOT, next);
    this.revision = next;
  }

  async save(data) {
    if (this.revision === undefined) throw Error('Сначала загрузите склад.');
    const revision = this.revision;
    const current = await callCloud(this.api, 'getItem', ROOT);
    if (current !== revision) throw Error('Склад изменён на другом устройстве. Обновите данные перед продолжением.');

    const {payload, encoding} = await encodeSnapshot(JSON.stringify(validate(data)));
    const chunks = [];
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) chunks.push(payload.slice(i, i + CHUNK_SIZE));
    if (chunks.length > MAX_CHUNKS) {
      throw Error('Облачный склад заполнен. Скачайте резервную копию и удалите ненужную историю.');
    }

    const gen = Date.now().toString(36) + '-' + crypto.randomUUID().replaceAll('-', '');
    const manifest = {v: encoding === 'gzip' ? 2 : 1, gen, count: chunks.length,
      hash: await digest(payload), savedAt: Date.now()};
    if (encoding === 'gzip') manifest.encoding = encoding;
    const keys = chunkKeys(manifest);
    for (let i = 0; i < chunks.length; i += 4) {
      await Promise.all(chunks.slice(i, i + 4).map((part, n) =>
        callCloud(this.api, 'setItem', keys[i + n], part)));
    }
    if (await callCloud(this.api, 'getItem', ROOT) !== revision) {
      throw Error('Склад изменён на другом устройстве. Обновите данные.');
    }

    const next = JSON.stringify(manifest);
    // Publish the new snapshot only after every chunk has been saved.
    await callCloud(this.api, 'setItem', ROOT, next);
    this.revision = next;
    // Cleanup can wait. An interrupted cleanup is picked up by a later save.
    this.cleanOldChunks(chunkKeys(current ? JSON.parse(current) : null)).catch(() => {});
    return data;
  }
}
export class LocalStore {
  constructor(storage) { this.storage=storage; this.revision=undefined; this.label='Этот браузер'; }
  async load() {
    const raw=this.storage.getItem(ROOT); const data=raw?validate(JSON.parse(raw)):EMPTY(); this.revision=raw; return data;
  }
  async save(data) {
    if(this.revision===undefined) throw Error('Сначала загрузите склад.');
    if(this.storage.getItem(ROOT)!==this.revision) throw Error('Склад изменён в другой вкладке. Обновите данные.');
    const raw=JSON.stringify(validate(data)); this.storage.setItem(ROOT,raw); this.revision=raw;
  }
}
