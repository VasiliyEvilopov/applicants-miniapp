export const isPhone = s => /^\+?[\d\s()\-]{7,}$/.test(s);
export const kindOf = s => isPhone(s) ? 'p' : 'u';
export const norm = s => isPhone(s) ? s.replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7') : s.replace(/^@/,'').toLowerCase();
export const id = () => crypto.randomUUID();
export function add(data,text,name='',mixed=false,dedupe=true) {
 const known = new Set(data.stock.flatMap(b=>b.items).map(norm));
 let duplicates=0; const fresh=[];
 for(const line of text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
  if(dedupe && known.has(norm(line))) { duplicates++;continue; } known.add(norm(line));fresh.push(line);
 }
 for(const kind of mixed?['mixed']:['u','p']) {
  const items=mixed?fresh:fresh.filter(x=>kindOf(x)===kind);
  if(items.length)data.stock.push({id:id(),kind,name:name.trim().slice(0,60)||'Новая партия',createdAt:Date.now(),total:items.length,items});
 }
 return {added:fresh.length,duplicates};
}
export function take(data,nu,np,batchId=null,issuedAt=null) {
 const need={u:nu,p:np},got={u:[],p:[]};
 for(const b of [...data.stock].sort((a,b)=>a.createdAt-b.createdAt)) {
  b.items=b.items.filter(x=>{const k=kindOf(x);if(batchId?b.id===batchId:need[k]>0){got[k].push(x);need[k]--;return false}return true});
 }
 data.stock=data.stock.filter(b=>b.items.length);
 if(!got.u.length&&!got.p.length)throw Error('Нечего забирать.');
 const t={...(issuedAt ?? {id:id(),takenAt:Date.now()}),users:got.u,phones:got.p};data.issued.push(t);return t;
}
export function restore(data,issueId,batchMetadata=[]) {
 const t=data.issued.find(t=>t.id===issueId);if(!t)throw Error('Выдача уже возвращена.');
 const batches=[];
 for(const [kind,key] of [['u','users'],['p','phones']])if(t[key].length){
  const metadata=batchMetadata.find(batch=>batch.kind===kind);
  batches.push({id:metadata?.id??id(),kind,name:'Возврат выдачи',createdAt:metadata?.createdAt??Date.now(),total:t[key].length,items:[...t[key]]});
 }
 data.stock.push(...batches);
 data.issued=data.issued.filter(t=>t.id!==issueId);
 return batches;
}
export function mixedCounts(total) {
 if(!Number.isSafeInteger(total) || total < 1)throw Error('Введите целое количество откликов больше нуля.');
 const phones=Math.floor(total/4);
 return {users:total-phones,phones};
}
export function takeMixed(data,total) {
 const {users,phones}=mixedCounts(total);
 const available={u:0,p:0};
 for(const batch of data.stock)for(const item of batch.items)available[kindOf(item)]++;
 if(available.u<users || available.p<phones){
  throw Error(`Для ${total} откликов нужно ${users} юзернеймов и ${phones} номеров. На складе: ${available.u} юзернеймов и ${available.p} номеров.`);
 }
 return take(data,users,phones,null,{id:id(),takenAt:Date.now(),order:'3u1p'});
}
export function issueText(issue) {
 if(issue.order!=='3u1p')return [issue.users.join('\n'),issue.phones.join('\n')].filter(Boolean).join('\n\n');
 const lines=[];
 for(let i=0;i<issue.users.length;i+=3){
  lines.push(...issue.users.slice(i,i+3));
  const phone=issue.phones[i/3];
  if(phone!==undefined)lines.push(phone);
 }
 return lines.join('\n');
}
const PHONE_RE = /(?<![\d\w])\+?\d[\d\s\-(). ]{8,22}\d(?!\d)/g;

function digitsOf(s){return s.replace(/\D/g,'')}
function isPhoneRaw(raw){
  const d=digitsOf(raw);
  if(d.length<10||d.length>15) return false;
  if(/\d{4}\s*[–-]\s*\d{4}/.test(raw) && d.length===8) return false;
  return true;
}
function normalize(raw){
  let d=digitsOf(raw);
  if(d.length===11 && (d[0]==='8'||d[0]==='7')) return '7'+d.slice(1);
  if(d.length===10 && d[0]==='9') return '7'+d;
  return d;
}
function keyOf(raw){
  let d=digitsOf(raw);
  if(d.length===11 && (d[0]==='8'||d[0]==='7')) d='7'+d.slice(1);
  if(d.length===10 && d[0]==='9') d='7'+d;
  return d;
}
function tidy(line){
  return line
    .replace(/(?:тел(?:ефон)?\.?|моб(?:ильный)?\.?|ph(?:one)?\.?|т\.)\s*[:№]?\s*(?=$|[,;|—–-])/gi,'')
    .replace(/\(\s*\)/g,'')
    .replace(/\s+([,;.:!?])/g,'$1')
    .replace(/([,;|—–-])\s*(?=[,;|—–-])/g,'')
    .replace(/[ \t ]{2,}/g,' ')
    .replace(/^[\s,;:|—–-]+|[\s,;:|—–-]+$/g,'')
    .trim();
}

export function sort(text,{dedup=true,norm=true,drop=true,sep='blank'}={}) {
 const kept=[],phones=[],seen=new Set();let duplicates=0;
 for(const line of text.split(/\r?\n/)) {
  let had=false;
  const cleaned=line.replace(PHONE_RE,m=>{
   if(!isPhoneRaw(m))return m;had=true;const k=keyOf(m),dup=seen.has(k);
   if(dup)duplicates++;if(!(dup&&dedup))phones.push(norm?normalize(m):m.trim().replace(/^\+/,''));seen.add(k);return ' ';
  });
  const t=had?tidy(cleaned):line.replace(/\s+$/,'');if(had&&!t&&drop)continue;kept.push(t);
 }
 while(kept.length&&!kept.at(-1).trim())kept.pop();let result=kept.join('\n');
 if(phones.length){const block=(sep==='title'?'Номера:\n':'')+phones.join('\n');result=result?result+(sep==='none'?'\n':'\n\n')+block:block;}
 return {result,phones,duplicates};
}

// Remove phone-like digit sequences from arbitrary text. By default only
// compact values beginning with 7 are removed (for example 7900494). The
// spaced form is opt-in because spaces may be meaningful in ordinary text.
export function removeNumberSequences(text, {includeSpaced = false} = {}) {
 const compact = /(?<!\d)7\d{6,14}(?!\d)/g;
 const spaced = /(?<!\d)\+?7(?:[\s().-]*\d){6,14}(?!\d)/g;
 const pattern = includeSpaced ? spaced : compact;
 let removed = 0;
 const result = String(text ?? '').split(/\r?\n/).map(line => line.replace(pattern, () => { removed++; return ''; }).replace(/[ \t]{2,}/g, ' ').trim()).join('\n');
 return {text: result, removed};
}
