import {CloudStore,LocalStore,EMPTY,validate} from './storage.mjs';
import {add,take,restore,isPhone,sort} from './core.mjs';
const $=id=>document.getElementById(id),tg=window.Telegram?.WebApp;
const inTelegram=!!(tg?.initData && tg?.initDataUnsafe?.user);
let store,data=EMPTY(),ready=false,busy=false,sortResult={result:'',phones:[],duplicates:0},currentIssue=null;
const number=n=>n.toLocaleString('ru-RU');
const date=ts=>new Date(ts).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=!text;}
function setStatus(text,error=false){$('storage-status').replaceChildren();const dot=document.createElement('i');$('storage-status').append(dot,document.createTextNode(text));$('storage-status').classList.toggle('error',error);}
function switchView(view){for(const name of ['stock','sort','history'])$('view-'+name).hidden=name!==view;document.querySelectorAll('[data-view]').forEach(b=>{b.removeAttribute('aria-current');if(b.dataset.view===view)b.setAttribute('aria-current','page');});tg?.BackButton?.hide();}
function counts(){let u=0,p=0;for(const b of data.stock)for(const x of b.items)isPhone(x)?p++:u++;return {u,p};}
function wanted(k){const v=$('take-'+k).value.trim().toLowerCase(),max=counts()[k];return ['all','все'].includes(v)?max:Math.min(max,/^\d+$/.test(v)?Number(v):0);}
function updateTake(){const u=wanted('u'),p=wanted('p');$('take-summary').textContent=u||p?`К выдаче: ${number(u)} юзернеймов и ${number(p)} номеров`:'Выберите количество для выдачи';$('take').disabled=!ready||busy||!(u||p);}
function intakeHint(){const text=$('intake-text').value,lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const d=structuredClone(data);const r=add(d,text,'',false,$('dedupe').checked);$('intake-hint').textContent=lines.length?`Строк: ${number(lines.length)} · новых: ${number(r.added)} · дублей: ${number(r.duplicates)}`:'Один юзернейм или номер в каждой строке.';}
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
  actions.append(button('Забрать всю партию ↗',()=>mutate(d=>take(d,0,0,b.id),t=>{showIssue(t);toast('Партия выдана и сохранена в истории.');})),button('Удалить',async()=>{if(await confirmAction('Удалить партию?',`${b.items.length} контактов будут удалены со склада.`, 'Удалить'))await mutate(d=>{d.stock=d.stock.filter(x=>x.id!==b.id)},()=>toast('Партия удалена.'));},'danger'));
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
async function mutate(fn,success){
 if(!ready||busy)return;busy=true;render();setStatus('Сохранение…');
 try{const draft=structuredClone(data),result=fn(draft);await store.save(draft);data=draft;notice('');setStatus(store.label+' · сохранено');success?.(result);}
 catch(error){notice(error.message,true);setStatus('Не удалось сохранить',true);}
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
$('take').onclick=()=>mutate(d=>take(d,wanted('u'),wanted('p')),t=>{$('take-u').value='0';$('take-p').value='0';showIssue(t);toast('Выдача сохранена в истории.');});
$('intake-text').oninput=intakeHint;$('dedupe').onchange=intakeHint;
$('intake').onsubmit=async e=>{e.preventDefault();const text=$('intake-text').value;if(!text.trim()){toast('Вставьте список контактов.');return;}await mutate(d=>add(d,text,$('batch-name').value,$('mixed').checked,$('dedupe').checked),r=>{if(r.added){$('intake-text').value='';$('batch-name').value='';}toast(`Добавлено: ${r.added} · дублей: ${r.duplicates}`);});};
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
