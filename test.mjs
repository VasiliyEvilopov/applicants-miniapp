import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudStore,LocalStore,validate,EMPTY} from './storage.mjs';
import {add,take,restore,sort} from './core.mjs';
function fakeCloud(){const map=new Map();let fail=false;return {map,set fail(v){fail=v},getItem(k,cb){cb(null,map.get(k)||'')},getItems(ks,cb){cb(null,Object.fromEntries(ks.map(k=>[k,map.get(k)||''])))},getKeys(cb){cb(null,[...map.keys()])},setItem(k,v,cb){if(fail&&k!=='applicants_v1')return cb('offline');map.set(k,v);cb(null,true)},removeItems(ks,cb){ks.forEach(k=>map.delete(k));cb(null,true)}}}
test('FIFO, phone classification, dedupe against stock, return once',()=>{const d=EMPTY();assert.deepEqual(add(d,'@Alice\nalice\n8 (916) 123-45-67\n79161234567'),{added:2,duplicates:2});add(d,'@Bob');const t=take(d,1,1);assert.deepEqual(t.users,['@Alice']);assert.equal(add(d,'bob').added,0);restore(d,t.id);assert.throws(()=>restore(d,t.id));assert.equal(d.stock.flatMap(b=>b.items).length,3);});
test('sort phones without losing names, normalizes and removes repeats',()=>{assert.deepEqual(sort('Иван, +7 (916) 123-45-67, менеджер\n8 (916) 123-45-67\n@alice'),{result:'Иван, менеджер\n@alice\n\n79161234567',phones:['79161234567'],duplicates:1});});
test('legacy JSON migrates, invalid payload rejected',()=>{assert.equal(validate({stock:[],issued:[{id:'a',items:['@alice','79161234567']}]}).issued[0].phones.length,1);assert.throws(()=>validate({stock:[{items:'oops'}],issued:[]}));});
test('cloud snapshot is split, durable, and failure preserves old version',async()=>{const api=fakeCloud(),s=new CloudStore(api),d=await s.load();add(d,Array.from({length:600},(_,i)=>'@example_'+i).join('\n'));await s.save(d);const s2=new CloudStore(api);assert.equal((await s2.load()).stock[0].items.length,600);const pointer=api.map.get('applicants_v1');api.fail=true;add(d,'@extra');await assert.rejects(()=>s.save(d));assert.equal(api.map.get('applicants_v1'),pointer);assert.equal((await new CloudStore(api).load()).stock[0].items.length,600);});
test('stale device cannot overwrite a newer snapshot',async()=>{const api=fakeCloud(),a=new CloudStore(api),b=new CloudStore(api);const da=await a.load(),db=await b.load();add(da,'@one');await a.save(da);add(db,'@two');await assert.rejects(()=>b.save(db),/другом устройстве/);});
test('missing cloud chunk is an error and never becomes an empty stock',async()=>{const api=fakeCloud(),s=new CloudStore(api),d=await s.load();add(d,'@one');await s.save(d);const key=[...api.map.keys()].find(k=>k!=='applicants_v1');api.map.delete(key);await assert.rejects(()=>new CloudStore(api).load(),/не полностью/);});
test('local save survives reopen and rejects another tab overwrites',async()=>{const m=new Map(),local={getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)},a=new LocalStore(local),b=new LocalStore(local);const d=await a.load();await b.load();add(d,'@one');await a.save(d);assert.equal((await new LocalStore(local).load()).stock.length,1);await assert.rejects(()=>b.save(EMPTY()),/другой вкладке/);});

test('issued contacts can be added again; current stock and incoming repeats are skipped',()=>{
 const d=EMPTY();
 add(d,'@Alice\n8 (916) 123-45-67\n@Bob');
 take(d,1,1);
 assert.deepEqual(add(d,'alice\n@ALICE\n+79161234567\n8 (916) 123-45-67\n@bob'),{added:2,duplicates:3});
 assert.equal(d.issued.length,1);
 assert.equal(d.stock.flatMap(b=>b.items).length,3);
 assert.deepEqual(add(d,'@Alice\n79161234567'),{added:0,duplicates:2});
});

test('large cloud stock compresses and issuance finishes before cleanup', async () => {
  const api = fakeCloud();
  const store = new CloudStore(api);
  const data = await store.load();
  add(data, Array.from({length: 10000}, (_, i) => '@candidate_' + i).join('\n'));
  await store.save(data);
  const root = 'applicants_v1';
  const first = JSON.parse(api.map.get(root));
  assert.equal(first.encoding, 'gzip');
  assert.ok(first.count < Math.ceil(JSON.stringify(data).length / 3000) / 2);
  assert.deepEqual(await new CloudStore(api).load(), data);

  const cleanup = api.removeItems;
  let finishCleanup;
  const cleaning = new Promise(resolve => {
    api.removeItems = (keys, callback) => {
      finishCleanup = () => cleanup(keys, callback);
      resolve();
    };
  });
  take(data, 50, 0);
  await store.save(data);
  await cleaning;
  assert.deepEqual(await new CloudStore(api).load(), data);
  finishCleanup();
});

test('ordinary issuance writes one key and replays on reopen', async () => {
  const api = fakeCloud();
  const store = new CloudStore(api);
  const data = await store.load();
  add(data, '@first\n@second\n@third', '', true);
  await store.save(data);

  const writes = [];
  const setItem = api.setItem;
  api.setItem = (key, value, callback) => {
    writes.push(key);
    setItem(key, value, callback);
  };
  const issue = take(data, 1, 0);
  await store.saveIssue(data, {users: 1, phones: 0, batchId: null, id: issue.id, takenAt: issue.takenAt});
  assert.deepEqual(writes, ['applicants_v1']);
  const reopened = new CloudStore(api);
  assert.deepEqual(await reopened.load(), data);

  const batchId = data.stock[0].id;
  const rest = take(data, 0, 0, batchId);
  await store.saveIssue(data, {users: 0, phones: 0, batchId, id: rest.id, takenAt: rest.takenAt});
  assert.deepEqual(await new CloudStore(api).load(), data);
  await assert.rejects(() => reopened.save(data), /другом устройстве/);
  await store.save(data);
  assert.deepEqual(await new CloudStore(api).load(), data);
});
