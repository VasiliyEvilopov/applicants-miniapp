import {CloudStore,LocalStore,EMPTY,validate} from './storage.mjs?v=4';
import {add,take,restore,isPhone,sort} from './core.mjs?v=4';
const $=id=>document.getElementById(id),tg=window.Telegram?.WebApp;
const inTelegram=!!(tg?.initData && tg?.initDataUnsafe?.user);
let store,data=EMPTY(),ready=false,busy=false,sortResult={result:'',phones:[],duplicates:0},currentIssue=null;
const number=n=>n.toLocaleString('ru-RU');
const date=ts=>new Date(ts).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=!text;}
function setStatus(text,error=false){$('storage-status').replaceChildren();const dot=document.createElement('i');$('storage-status').append(dot,document.createTextNode(text));$('storage-status').classList.toggle('error',error);}
function switchView(view){for(const name of ['stock','sort','history','cloner'])$('view-'+name).hidden=name!==view;document.querySelectorAll('[data-view]').forEach(b=>{b.removeAttribute('aria-current');if(b.dataset.view===view)b.setAttribute('aria-current','page');});tg?.BackButton?.hide();}
function counts(){let u=0,p=0;for(const b of data.stock)for(const x of b.items)isPhone(x)?p++:u++;return {u,p};}
function wanted(k){const v=$('take-'+k).value.trim().toLowerCase(),max=counts()[k];return ['all','все'].includes(v)?max:Math.min(max,/^\d+$/.test(v)?Number(v):0);}
function updateTake(){const u=wanted('u'),p=wanted('p');$('take-summary').textContent=u||p?`К выдаче: ${number(u)} юзернеймов и ${number(p)} номеров`:'Выберите количество для выдачи';$('take').disabled=!ready||busy||!(u||p);}
function intakeHint(){const text=$('intake-text').value,lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const r=lines.length ? add({stock:[...data.stock]},text,'',false,$('dedupe').checked) : null;$('intake-hint').textContent=lines.length?`Строк: ${number(lines.length)} · новых: ${number(r.added)} · дублей: ${number(r.duplicates)}`:'Один юзернейм или номер в каждой строке.';}
function element(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function button(text,fn,cls=''){const b=element('button',cls,text);b.type='button';b.disabled=!ready||busy;b.onclick=fn;return b;}
function empty(target,title,description){const e=element('div','empty');e.append(element('span','', '◇'),element('strong','',title),document.createTextNode(description));target.append(e);}
function render(){
 const c=counts();$('count-u').textContent=number(c.u);$('count-p').textContent=number(c.p);$('batch-count').textContent=`Партий: ${number(data.stock.length)}`;$('history-count').textContent=number(data.issued.length);
 const today=new Date().toDateString(),issuedToday=data.issued.filter(t=>new Date(t.takenAt).toDateString()===today).reduce((n,t)=>n+t.users.length+t.phones.length,0);$('today').textContent=`Сегодня выдано: ${number(issuedToday)}`;
 const batches=$('batches');batches.replaceChildren();
 if(!data.stock.length)empty(batches,ready?'Пока ни одного контакта':'Загружаем склад…',ready?'Добавьте первую партию или импортируйте sklad.json.':'');
 for(const b of [...data.stock].sort((a,b)=>a.createdAt-b.createdAt)){
  const el=element('article','record'),head=element('div','record-head'),actions=element('div','record-actions');
  head.append(element('strong','',number(b.items.length)),element('span','badge '+b.kind,{u:'юзернеймы',p:'номера',mixed:'общая'}[b.kind]),element('span','record-title',b.name),element('span','record-date',date(b.createdAt)));
  actions.append(button('Забрать всю партию ↗',()=>issueContacts(0,0,b.id)),button('Удалить',async()=>{if(await confirmAction('Удалить партию?',`${b.items.length} контактов будут удалены со склада.`, 'Удалить'))await mutate(d=>{d.stock=d.stock.filter(x=>x.id!==b.id)},()=>toast('Партия удалена.'));},'danger'));
  el.append(head,element('p','peek',b.items.slice(0,5).join(' · ')+(b.items.length>5?' …':'')),actions);batches.append(el);
 }
 const issues=$('issues');issues.replaceChildren();
 if(!data.issued.length)empty(issues,'Выдач ещё нет','Когда заберёте контакты со склада, список появится здесь.');
 for(const t of [...data.issued].reverse()){
  const el=element('article','record'),head=element('div','record-head'),actions=element('div','record-actions');
  head.append(element('strong','',number(t.users.length+t.phones.length)),element('span','badge',`Юзернеймы: ${t.users.length}`),element('span','badge p',`Номера: ${t.phones.length}`),element('span','record-date',date(t.takenAt)));
  actions.append(button('Открыть список',()=>showIssue(t)),button('Вернуть на склад',async()=>{if(await confirmAction('Вернуть выдачу?',`Контакты снова появятся на складе. Количество: ${t.users.length+t.phones.length}.`, 'Вернуть'))await mutate(d=>restore(d,t.id),()=>toast('Контакты возвращены на склад.'));}),button('Удалить',async()=>{if(await confirmAction('Удалить из истории?','Эта копия выданного списка будет удалена. Контакты на склад не возвращаются.','Удалить'))await mutate(d=>{d.issued=d.issued.filter(x=>x.id!==t.id)},()=>toast('Выдача удалена.'));},'danger'));
  el.append(head,element('p','peek',[...t.users,...t.phones].slice(0,5).join(' · ')),actions);issues.append(el);
 }
 $('intake').querySelector('button[type=submit]').disabled=!ready||busy;$('export').disabled=!ready||busy;$('refresh').disabled=busy;$('import').disabled=!ready||busy;updateTake();intakeHint();
}
async function mutate(fn,success,save=(draft)=>store.save(draft)){
 if (!ready || busy) return false;
 busy = true;
 updateTake();
 setStatus('Сохранение…');
 try{const draft=structuredClone(data),result=fn(draft);await save(draft,result);data=draft;notice('');setStatus(store.label+' · сохранено');success?.(result);return true;}
 catch(error){notice(error.message,true);setStatus('Не удалось сохранить',true);return false;}
 finally{busy=false;render();}
}
async function reload(){
 if(busy)return;busy=true;render();setStatus('Загрузка…');
 try{data=await store.load();ready=true;notice('');setStatus(store.label+' · сохранено');}
 catch(error){ready=false;notice(error.message,true);setStatus('Хранилище недоступно',true);}
 finally{busy=false;render();}
}
function confirmAction(title,text,label='Продолжить'){
 if($('confirm-dialog').open)return Promise.resolve(false);
 $('confirm-title').textContent=title;$('confirm-description').textContent=text;$('confirm-ok').textContent=label;$('confirm-dialog').showModal();
 return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;$('confirm-dialog').close();resolve(value);};$('confirm-ok').onclick=()=>finish(true);$('confirm-cancel').onclick=()=>finish(false);$('confirm-dialog').oncancel=e=>{e.preventDefault();finish(false);};});
}
function download(name,text,type='text/plain'){const url=URL.createObjectURL(new Blob([text],{type:type+';charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function copy(text){if(!text){toast('Список пуст.');return;}try{await navigator.clipboard.writeText(text);toast('Скопировано.');}catch{const field=$('output-dialog').open?$('output-text'):$('sort-output');field.focus();field.select();toast('Текст выделен. Нажмите «Копировать» в меню выделения.');}}
function showIssue(t){currentIssue=t;$('output-title').textContent=`Контакты · ${number(t.users.length+t.phones.length)}`;$('output-description').textContent=`${date(t.takenAt)} · юзернеймов: ${t.users.length} · номеров: ${t.phones.length}`;$('output-text').value=[t.users.join('\n'),t.phones.join('\n')].filter(Boolean).join('\n\n');$('output-dialog').showModal();}
function runSort(){sortResult=sort($('sort-input').value,{dedup:$('sort-dedup').checked,norm:$('sort-norm').checked,drop:$('sort-drop').checked,sep:$('sort-sep').value});$('sort-output').value=sortResult.result;$('sort-stats').textContent=`Найдено номеров: ${sortResult.phones.length} · повторов: ${sortResult.duplicates}`;$('sort-to-stock').disabled=!sortResult.phones.length;try{sessionStorage.setItem('applicants-sort',JSON.stringify({text:$('sort-input').value,dedup:$('sort-dedup').checked,norm:$('sort-norm').checked,drop:$('sort-drop').checked,sep:$('sort-sep').value}));}catch{}}
async function readFile(file){if(file.size>5*1024*1024)throw Error('Выберите файл до 5 МБ.');const bytes=await file.arrayBuffer();try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return new TextDecoder('windows-1251').decode(bytes)}}
function bindFile(id,fn){$(id).onchange=async e=>{const file=e.target.files[0];if(!file)return;try{await fn(await readFile(file),file.name)}catch(error){notice(error.message,true)}finally{e.target.value=''}};}
$('refresh').onclick=reload;
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
document.querySelectorAll('[data-count]').forEach(b=>b.onclick=()=>{$('take-'+b.dataset.kind).value=b.dataset.count==='all'?'все':b.dataset.count;updateTake();});
for(const k of ['u','p']){$('take-'+k).oninput=updateTake;$('take-'+k).onfocus=e=>e.target.select();}
function issueContacts(users, phones, batchId = null) {
 return mutate(
  draft => take(draft, users, phones, batchId),
  issue => {
   $('take-u').value = '0';
   $('take-p').value = '0';
   showIssue(issue);
   toast('Выдача сохранена в истории.');
  },
  (draft, issue) => store.saveIssue
   ? store.saveIssue(draft, {users, phones, batchId, id: issue.id, takenAt: issue.takenAt})
   : store.save(draft),
 );
}
$('take').onclick=()=>issueContacts(wanted('u'),wanted('p'));
$('intake-text').oninput=intakeHint;$('dedupe').onchange=intakeHint;
$('intake').onsubmit=async e=>{
 e.preventDefault();
 if(!ready || busy)return;
 const text=$('intake-text').value,name=$('batch-name').value;
 const feedback=$('intake-feedback');
 feedback.hidden=false;
 feedback.classList.remove('error');
 if(!text.trim()){feedback.textContent='Вставьте список контактов.';return;}
 const submit=e.currentTarget.querySelector('button[type=submit]');
 submit.disabled=true;
 feedback.textContent='Сохраняем партию…';
 const saved=await mutate(
  draft=>add(draft,text,name,$('mixed').checked,$('dedupe').checked),
  result=>{
   if(result.added && $('intake-text').value===text && $('batch-name').value===name){
    $('intake-text').value='';
    $('batch-name').value='';
   }
   feedback.textContent=`Добавлено: ${result.added} · дублей: ${result.duplicates}`;
  },
  (draft,result)=>{
   if(!result.added)return;
   return store.saveAddition ? store.saveAddition(draft,draft.stock.slice(data.stock.length)) : store.save(draft);
  },
 );
 if(!saved){
  feedback.textContent=$('notice').textContent;
  feedback.classList.add('error');
 }
};
bindFile('intake-file',(text)=>{$('intake-text').value=text;intakeHint();toast('Список загружен. Проверьте и добавьте на склад.');});
bindFile('sort-file',(text)=>{$('sort-input').value=text;runSort();});
$('output-close').onclick=()=>$('output-dialog').close();$('output-copy').onclick=()=>copy($('output-text').value);$('output-download').onclick=()=>download(`issue-${currentIssue.id}.txt`,$('output-text').value);
$('export').onclick=()=>{if(ready)download('sklad.json',JSON.stringify(data,null,2),'application/json')};
bindFile('import',async text=>{if(!ready||busy)return;const imported=validate(JSON.parse(text));const count=imported.stock.reduce((n,b)=>n+b.items.length,0);if(await confirmAction('Импортировать склад?',`В файле ${count} контактов и ${imported.issued.length} выдач. Текущий склад и история будут заменены. Сначала скачайте резервную копию, если хотите их сохранить.`,'Импортировать'))await mutate(d=>{d.stock=imported.stock;d.issued=imported.issued;},()=>toast(`Импортировано ${count} контактов.`));});
$('sort-input').oninput=runSort;for(const id of ['sort-dedup','sort-norm','sort-drop','sort-sep'])$(id).onchange=runSort;
$('sort-clear').onclick=()=>{$('sort-input').value='';runSort();};$('sort-copy').onclick=()=>copy(sortResult.result);$('sort-download').onclick=()=>download('sorted.txt',sortResult.result);
$('sort-to-stock').onclick=()=>{$('intake-text').value=sortResult.phones.join('\n');$('batch-name').value='Из сортировки';intakeHint();switchView('stock');$('intake-text').focus();$('intake-text').scrollIntoView({block:'center',behavior:'smooth'});toast('Номера перенесены в форму. Нажмите «Добавить на склад».');};
try{const s=JSON.parse(sessionStorage.getItem('applicants-sort'));if(s){$('sort-input').value=s.text||'';for(const k of ['dedup','norm','drop'])$('sort-'+k).checked=s[k]!==false;$('sort-sep').value=s.sep||'blank';}}catch{}
window.addEventListener('storage',e=>{if(e.key==='applicants_v1'&&ready&&!busy)reload();});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
if(inTelegram){
 tg.ready();tg.expand();
 if(!tg.isVersionAtLeast('6.9')){notice('Для облачного склада обновите Telegram до актуальной версии.',true);setStatus('Нужно обновить Telegram',true);render();}
 else{store=new CloudStore(tg.CloudStorage);$('storage-help').textContent='Личный склад хранится в облаке Telegram и доступен с ваших устройств в этом боте. Браузерный склад переносится через резервную копию.';reload();}
}else{
 try{store=new LocalStore(localStorage);$('storage-help').textContent='Сейчас данные сохраняются в этом браузере. После подключения к боту склад внутри Mini App будет храниться в облаке Telegram. Перенос — через резервную копию.';reload();}
 catch(error){notice('Браузер запретил сохранение. Разрешите хранилище для этого сайта.',true);setStatus('Сохранение недоступно',true);render();}
}
runSort();

// ── Клонер TData ───────────────────────────────────────────────────────────
const CLONER_API = 'https://applicants-miniapp-production.up.railway.app';
let clonerJobId = null;
let clonerPollTimer = null;

$('cloner-file').onchange = e => {
  const files = [...e.target.files];
  const list = $('cloner-filelist');
  list.innerHTML = '';
  files.forEach(f => {
    const li = document.createElement('li');
    li.textContent = f.name;
    list.append(li);
  });
};

$('cloner-form').onsubmit = async e => {
  e.preventDefault();
  const proxy = $('cloner-proxy').value.trim();
  const files = [...$('cloner-file').files];

  if (!proxy) { toast('Укажите прокси или «-» для работы без него.'); return; }
  if (!files.length) { toast('Выберите хотя бы один .zip архив.'); return; }

  $('cloner-submit').disabled = true;
  $('cloner-status-card').hidden = false;
  $('cloner-status-text').textContent = `⏳ Отправка ${files.length} файл(ов)…`;
  $('cloner-download').hidden = true;
  if (clonerPollTimer) clearInterval(clonerPollTimer);

  try {
    const fd = new FormData();
    fd.append('proxy', proxy);
    for (const f of files) fd.append('tdata_zip', f, f.name);

    const resp = await fetch(`${CLONER_API}/clone`, { method: 'POST', body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({detail: resp.statusText}));
      throw new Error(err.detail || resp.statusText);
    }
    const { job_id, files: cnt } = await resp.json();
    clonerJobId = job_id;
    $('cloner-status-text').textContent = `🔄 Клонирование ${cnt ?? files.length} архив(ов)…`;
    clonerPollTimer = setInterval(clonerPoll, 3000);
  } catch (err) {
    $('cloner-status-text').textContent = `❌ Ошибка: ${err.message}`;
    $('cloner-submit').disabled = false;
  }
};

async function clonerPoll() {
  if (!clonerJobId) return;
  try {
    const r = await fetch(`${CLONER_API}/status/${clonerJobId}`);
    const j = await r.json();
    if (j.status === 'done') {
      clearInterval(clonerPollTimer);
      const ok = j.ok_count ?? '?';
      const total = j.total ?? '?';
      $('cloner-status-text').textContent = `✅ Готово! Склонировано: ${ok}/${total}`;
      $('cloner-download').hidden = false;
      $('cloner-submit').disabled = false;
    } else if (j.status === 'error') {
      clearInterval(clonerPollTimer);
      $('cloner-status-text').textContent = `❌ Ошибка: ${j.error || 'неизвестная ошибка'}`;
      $('cloner-submit').disabled = false;
    } else {
      const ok = j.ok_count ?? 0;
      const total = j.total ?? '?';
      $('cloner-status-text').textContent =
        `🔄 Клонирование… ${ok > 0 ? ok + '/' + total + ' готово ' : ''}(ждём коды)`;
    }
  } catch {}
}

$('cloner-download').onclick = () => {
  if (!clonerJobId) return;
  const a = document.createElement('a');
  a.href = `${CLONER_API}/result/${clonerJobId}`;
  a.download = 'cloned_tdata.zip';
  document.body.append(a);
  a.click();
  a.remove();
};

// ── Cloner history ─────────────────────────────────────────────────────────

async function loadClonerHistory() {
  const container = $('cloner-history-list');
  try {
    const r = await fetch(`${CLONER_API}/history`);
    if (!r.ok) throw new Error(r.statusText);
    const { history } = await r.json();

    if (!history || !history.length) {
      container.innerHTML = '<p class="hint">Пока ничего не клонировалось.</p>';
      return;
    }

    const rows = history.map(entry => {
      const dt = new Date(entry.ts * 1000).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      const okPhones = (entry.ok || []).map(o => `<code>+${o.phone}</code>`).join(' ');
      const errCount = (entry.errors || []).length;
      const statusIcon = entry.status === 'done' ? '✅' : '❌';
      const summary = entry.ok.length
        ? `${statusIcon} ${entry.ok.length}/${entry.files} аккаунт(ов)`
        : `${statusIcon} ошибка`;
      const errHint = errCount
        ? `<br><span class="hint">${errCount} ошибок: ${(entry.errors||[]).slice(0,3).map(e=>`${e.label}: ${e.error}`).join('; ')}</span>`
        : '';
      return `<div class="history-row">
        <div class="history-meta"><span class="hint">${dt}</span> ${summary}</div>
        <div class="history-phones">${okPhones}${errHint}</div>
      </div>`;
    });
    container.innerHTML = rows.join('<hr class="history-sep">');
  } catch (e) {
    container.innerHTML = `<p class="hint">Не удалось загрузить: ${e.message}</p>`;
  }
}

$('cloner-history-refresh').onclick = loadClonerHistory;

// Load history when switching to cloner tab
document.querySelectorAll('[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'cloner') loadClonerHistory();
  });
});

// Also load on poll completion
const _origClonerPoll = clonerPoll;
// refresh history after each successful clone
async function clonerPollWithHistory() {
  await _origClonerPoll();
  const txt = $('cloner-status-text').textContent;
  if (txt.startsWith('✅')) loadClonerHistory();
}

// Initial load if already on cloner tab
if (document.querySelector('[data-view="cloner"][aria-current="page"]')) {
  loadClonerHistory();
}
