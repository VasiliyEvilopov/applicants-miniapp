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
    api[method](...args, (error, result) => { clearTimeout(timeout); error ? reject(Error(String(error))) : resolve(result); });
  });
}
async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export class CloudStore {
  constructor(api) { this.api=api; this.revision=undefined; this.label='Облако Telegram'; }
  async load(attempt=0) {
    const raw = await callCloud(this.api,'getItem',ROOT);
    if (!raw) { this.revision=''; return EMPTY(); }
    let manifest;
    try { manifest=JSON.parse(raw); } catch { throw Error('Не удалось прочитать облачный склад. Не перезаписывайте его.'); }
    if (manifest.v!==1 || !/^[a-z0-9_-]+$/.test(manifest.gen) || !Number.isInteger(manifest.count) || manifest.count<1 || manifest.count>MAX_CHUNKS) throw Error('Повреждена запись облачного склада.');
    const keys=Array.from({length:manifest.count},(_,i)=>`${ROOT}_${manifest.gen}_${i}`), values={};
    for(let i=0;i<keys.length;i+=64) Object.assign(values, await callCloud(this.api,'getItems',keys.slice(i,i+64)));
    if(keys.some(k=>typeof values[k]!=='string' || !values[k])) {
      if(attempt<2 && await callCloud(this.api,'getItem',ROOT)!==raw)return this.load(attempt+1);
      throw Error('Склад загрузился не полностью. Повторите открытие.');
    }
    const text=keys.map(k=>values[k]).join('');
    if(await digest(text)!==manifest.hash) throw Error('Не прошла проверка целостности склада.');
    const data=validate(JSON.parse(text)); this.revision=raw; return data;
  }
  async save(data) {
    const text=JSON.stringify(validate(data)), chunks=[];
    for(let i=0;i<text.length;i+=CHUNK_SIZE) chunks.push(text.slice(i,i+CHUNK_SIZE));
    if(chunks.length>MAX_CHUNKS) throw Error('Облачный склад заполнен. Скачайте резервную копию и удалите ненужную историю.');
    if(this.revision===undefined) throw Error('Сначала загрузите склад.');
    const current=await callCloud(this.api,'getItem',ROOT);
    if(current!==this.revision) throw Error('Склад изменён на другом устройстве. Обновите данные перед продолжением.');
    const gen=Date.now().toString(36)+'-'+crypto.randomUUID().replaceAll('-','');
    // Never remove a recent uncommitted generation: another device may be writing it.
    const keep=current ? JSON.parse(current).gen : null;
    const keys=await callCloud(this.api,'getKeys');
    const stale=keys.filter(k=>{if(!k.startsWith(ROOT+'_') || (keep && k.startsWith(`${ROOT}_${keep}_`)))return false;const stamp=parseInt(k.slice(ROOT.length+1).split('-')[0],36);return Number.isFinite(stamp)&&stamp<Date.now()-3600000;});
    for(let i=0;i<stale.length;i+=64) await callCloud(this.api,'removeItems',stale.slice(i,i+64));
    for(let i=0;i<chunks.length;i+=4) await Promise.all(chunks.slice(i,i+4).map((part,n)=>callCloud(this.api,'setItem',`${ROOT}_${gen}_${i+n}`,part)));
    if(await callCloud(this.api,'getItem',ROOT)!==this.revision) throw Error('Склад изменён на другом устройстве. Обновите данные.');
    const next=JSON.stringify({v:1,gen,count:chunks.length,hash:await digest(text),savedAt:Date.now()});
    // The pointer changes last; incomplete uploads never replace the previous snapshot.
    await callCloud(this.api,'setItem',ROOT,next); this.revision=next;
    // Only the old committed generation is disposable after the new pointer is durable.
    if(keep){const old=keys.filter(k=>k.startsWith(`${ROOT}_${keep}_`));try{for(let i=0;i<old.length;i+=64)await callCloud(this.api,'removeItems',old.slice(i,i+64));}catch{/* A cleanup failure must not turn a committed save into an error. */}}
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
