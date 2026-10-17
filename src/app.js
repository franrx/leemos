// Leemos: syllable reading practice. ES module, no build step. See CLAUDE.md.
// ---------- data (edit the JSON files in src/data/, not this file) ----------
const loadJSON=(u,o)=>fetch(u,o).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json()});
const [LV_ES,LV_CA,WORLDS,STICKERS,T_ES,T_CA]=await Promise.all([
  loadJSON('src/data/levels.es.json'),loadJSON('src/data/levels.ca.json'),loadJSON('src/data/worlds.json'),
  loadJSON('src/data/stickers.json'),loadJSON('src/data/i18n.es.json'),loadJSON('src/data/i18n.ca.json')
]);
// The letter path rule (src/levelrule.js, pure; spec: docs/superpowers/specs/2026-10-17-elsas-path-design.md). Loaded through the
// same import seam as the other modules; if it cannot load, the path is simply off (every item is open), never a blank app.
const LR=await (async()=>{try{return await (window.__leemosImport||(p=>import(p)))('./levelrule.js')}catch(e){return {stepOf:()=>0,STEPS:['m','p','l','n','t','s','f','b','d','r','c','*']}}})();
const LV={es:LV_ES,ca:LV_CA};
let LEVELS=LV_ES;
const T={es:T_ES,ca:T_CA};

const wn=w=>S.lang==='ca'?w.nameCa:w.name;
const rnd=a=>a[Math.floor(Math.random()*a.length)];
const nm=()=>(typeof S.name==='string'?S.name:'').trim()||(PROFILE.kind==='pre'?PROFILE.name:'campeona');
const fmt=s=>s.replace('{n}',nm());

// ---------- i18n (castellano / català) ----------
const t=(k,v)=>{
  let s=(T[S.lang]||T.es)[k];if(s===undefined)s=T.es[k];
  if(Array.isArray(s)||!v)return s;
  for(const x in v)s=s.split('{'+x+'}').join(v[x]);
  return s;
};

// Split a syllable into onset + rest (m|a, pl|a, ch|a). Falls back to letter by letter.
const ONSET=/^(ch|ll|rr|qu|gu|tx|ny|[bcdfgjlmnprstvz][lr]|[bcdfghjklmnñpqrstvxzç])(?=[aeiouáéíóúàèòïü])/;
function splitSyl(s){
  const m=s.match(ONSET);
  if(m) return [m[1],s.slice(m[1].length)];
  return s.length===2?[s[0],s[1]]:[s];
}

// ---------- state ----------
// ---------- profiles (one saved state per child; Elsa keeps the original key) ----------
const PKEY='leemos-profiles';
// Keep the valid entries of a damaged store: drop non-objects, bad or duplicate ids; coerce name and kind.
const cleanProfiles=p=>{
  const seen=new Set(),list=[];
  (p&&Array.isArray(p.list)?p.list:[]).forEach(x=>{
    if(!x||typeof x.id!=='string'||!x.id||seen.has(x.id))return;
    seen.add(x.id);
    list.push({id:x.id,name:typeof x.name==='string'&&x.name.trim()?x.name.trim():x.id,kind:x.kind==='pre'?'pre':'reader',
      ...(typeof x.rid==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.rid)?{rid:x.rid}:{})});
  });
  return list.some(x=>x.id===p.active)?{active:p.active,list}:null;
};
const loadProfiles=()=>{
  try{const c=cleanProfiles(JSON.parse(localStorage.getItem(PKEY)));if(c)return c}catch(e){}
  return {active:'elsa',list:[{id:'elsa',name:'Elsa',kind:'reader'}]};
};
const PROFILES=loadProfiles();
const PROFILE=PROFILES.list.find(x=>x.id===PROFILES.active);
const saveProfiles=()=>{try{localStorage.setItem(PKEY,JSON.stringify(PROFILES));return true}catch(e){return false}};
const keyFor=id=>id==='elsa'?'leemos-v1':'leemos-v1:'+id;
const profileSlug=n=>n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function switchProfile(id){PROFILES.active=id;saveProfiles();location.reload()}
function addProfile(name,kind){
  const base=profileSlug(name)||'nino';let id=base,i=2;
  while(PROFILES.list.some(x=>x.id===id))id=base+'-'+i++;
  PROFILES.list.push({id,name:name.trim(),kind:kind==='pre'?'pre':'reader'});
  switchProfile(id);
}
const KEY=keyFor(PROFILE.id);
const load=()=>{try{return JSON.parse(localStorage.getItem(KEY))||{}}catch(e){return {}}};
const save=()=>{
  const fp=fpOf();
  if(fp!==lastFp){lastFp=fp;S.modAt=stampAfter(S.modAt);onProgressChange()} // never older than a stamp that came from a device with a faster clock
  if(lastSessFp!==null){
    const sf=sessFp();
    if(sf!==lastSessFp){lastSessFp=sf;S.session={done:sDone,ok:sOk,stk:sStk,at:stampAfter(S.session&&S.session.at)};onProgressChange()}
  }
  if(lastPref!==null){
    for(const k of PREF_KEYS){
      if(S[k]!==lastPref[k]){lastPref[k]=S[k];S.prefs[k]={v:S[k],at:stampAfter(S.prefs[k]&&S.prefs[k].at)};onProgressChange()}
    }
  }
  try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}
};
const S=Object.assign({stats:{},level:0,mode:'syl',upper:true,rate:.75,theme:'',name:PROFILE.name,total:0,progress:0,stickers:0,sound:true,voiceURI:'',voiceURIs:{es:'',ca:''},world:'auto',lang:((navigator.language||'').toLowerCase().indexOf('ca')===0?'ca':'es'),sessionLen:PROFILE.kind==='pre'?5:10,pre:{es:0,ca:0},resets:{es:0,ca:0},modAt:0,session:{done:0,ok:0,stk:0,at:0},prefs:{}},load());
// Stickers are collected per world (spec: 2026-10-17-world-stickers-design.md): S.stk = {worldId: n} owns the first n of that world's set.
// An old save has only the counter S.stickers: its stickers are the first ones of the old order, each in its world's set.
// Runs before lastFp is taken, so loading an old state is not a progress change (modAt decides level and name in the sync).
WORLDS.forEach(w=>{if(!Array.isArray(w.stk))w.stk=[]}); // a stale cached worlds.json from before the sets must not stop the app from starting
const stkTotal=()=>WORLDS.reduce((n,w)=>n+Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length),0);
if(!S.stk||typeof S.stk!=='object'||Array.isArray(S.stk)){
  const stk={};
  for(let i=0;i<Math.min(Math.max(0,Math.floor(Number(S.stickers))||0),STICKERS.length);i++){
    const w=WORLDS.find(x=>x.stk.includes(STICKERS[i]));
    if(w)stk[w.id]=(stk[w.id]||0)+1;
  }
  S.stk=stk;
}
S.stickers=stkTotal();
// Progress-change detection for sync: modAt is stamped only when a synced field changed (not for theme, voice, session length...).
const fpOf=()=>JSON.stringify([S.stats,S.total,S.stickers,S.stk,S.pre,S.resets,S.level,S.name]);
let lastFp=fpOf();
let sDone=0,sOk=0,sStk=0,pendingEnd=false,resting=false; // declared early: save() reads the session counters and may run during load
let onProgressChange=()=>{}; // replaced by the sync glue
// Session in progress and preferences (spec: docs/superpowers/specs/2026-10-17-session-prefs-sync-design.md). Each has its own
// timestamp, so none of them can overwrite another value on a second device or move modAt (which decides level and name).
const PREF_KEYS=['mode','world','sessionLen','upper','lang','rate','sound','theme','pathEs','pathCa','pathAuto']; // keep identical to merge.js; never the voice
const SESSION_TTL=12*3600*1000; // a session left over from yesterday must not resume
const MAX_AT=8.64e15; // keep identical to merge.js: a stamp beyond it is invalid there
const stampAfter=prev=>Math.min(MAX_AT,Math.max(Date.now(),(prev||0)+1));
const FUTURE_MARGIN=10*60*1000; // a device clock a few minutes ahead is tolerated; a stamp further in the future is never "recent"
const isFresh=(at,ttl)=>{const age=Date.now()-at;return age>=-FUTURE_MARGIN&&age<ttl};
if(!S.prefs||typeof S.prefs!=='object')S.prefs={};
const restoreSession=s=>{
  if(s&&s.at&&isFresh(s.at,SESSION_TTL)&&s.done<S.sessionLen){sDone=s.done|0;sOk=s.ok|0;sStk=s.stk|0}
};
restoreSession(S.session);
let lastSessFp=null,lastPref=null; // baselines, set once the state is loaded: a save() before that (a migration) stamps nothing
const sessFp=()=>sDone+'|'+sOk+'|'+sStk;
const prefSnap=()=>Object.fromEntries(PREF_KEYS.map(k=>[k,S[k]]));
if(!S.voiceURIs)S.voiceURIs={es:'',ca:''};
if(!S.pre)S.pre={es:0,ca:0};
// Camino de Elsa: how many letters are open per language. A profile that already has progress keeps every letter open (nothing
// changes until a parent closes some); a new one starts at M. Runs before the baselines (lastPref), so it stamps nothing.
{const started=S.total>0||Object.keys(S.stats).length>0,okPos=v=>Number.isInteger(v)&&v>=1&&v<=12;
 if(!okPos(S.pathEs))S.pathEs=started?12:1;if(!okPos(S.pathCa))S.pathCa=started?12:1;if(typeof S.pathAuto!=='boolean')S.pathAuto=true}
// One-time switch to capitals (the school book is all capitals): readers only, once per profile; she can switch back with Aa.
if(PROFILE.kind==='reader'&&!S.upperMigrated){if(!S.prefs.upper)S.upper=true;S.upperMigrated=true;save()} // a profile that already has a synced capitals preference keeps it
lastSessFp=sessFp();lastPref=prefSnap();
LEVELS=LV[S.lang]||LV_ES;
if(!(S.level>=0&&S.level<LEVELS.length)){S.level=0;lastFp=fpOf()} // a correction, not a progress change: no modAt stamp // a saved level that does not exist (newer app version, bad data) falls back to the first
let cur=null,last=null,phase='read',resetArmed=false;
let pre=null;
let curWorld=Math.floor(Math.random()*WORLDS.length);

const $=id=>document.getElementById(id);
const stat=k=>S.stats[k]||(S.stats[k]={ok:0,fail:0});
const mastered=k=>{const s=S.stats[k];return !!s&&s.ok>=2&&s.ok>s.fail};

// ---------- voice ----------
let voice=null,esVoices=[];
const hasTTS='speechSynthesis' in window;
function vscore(v){
  const n=(v.name+' '+v.voiceURI).toLowerCase();let s=0;
  if(/natural|neural|online/.test(n))s+=100;
  if(/premium|enhanced|mejorad|siri/.test(n))s+=80;
  if(/google/.test(n))s+=60;
  if(/monica|mónica|paulina|elena|elvira|lucia|lucía|laura|marisol|sabina|dalia|jorge|diego|joana|enric|montse|alba/.test(n))s+=20;
  if(new RegExp('^'+S.lang+'[-_]es','i').test(v.lang))s+=10;
  if(/espeak|compact/.test(n))s-=80;
  return s;
}
function pickVoice(){
  if(!hasTTS)return;
  esVoices=speechSynthesis.getVoices().filter(v=>new RegExp('^'+S.lang,'i').test(v.lang)).sort((a,b)=>vscore(b)-vscore(a));
  const chosen=esVoices.find(v=>v.voiceURI===S.voiceURIs[S.lang])||null;
  voice=chosen||esVoices[0]||null;
  const sel=$('voiceSel');sel.innerHTML='';
  const auto=document.createElement('option');auto.value='';auto.textContent=t('voiceAuto');sel.appendChild(auto);
  esVoices.forEach(v=>{const o=document.createElement('option');o.value=v.voiceURI;o.textContent=v.name+' ('+v.lang+')';sel.appendChild(o)});
  sel.value=chosen?chosen.voiceURI:'';
  $('voiceInfo').textContent=voice?t('voiceActive',{v:voice.name}):t('voiceNone');
}
if(hasTTS){pickVoice();speechSynthesis.onvoiceschanged=pickVoice}
else $('voiceInfo').textContent=t('voiceNoTTS');

// Recorded clips (parent's voice) live in IndexedDB and win over the device voice.
const clipURL={};
let curAudio=null;
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('leemos-audio',1);r.onupgradeneeded=()=>r.result.createObjectStore('clips');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function idbSet(k,b){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction('clips','readwrite');tx.objectStore('clips').put(b,k);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
async function idbClear(){const db=await idb();return new Promise((res,rej)=>{const tx=db.transaction('clips','readwrite');tx.objectStore('clips').clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})}
async function idbAll(){const db=await idb();return new Promise((res,rej)=>{const out={},c=db.transaction('clips').objectStore('clips').openCursor();c.onsuccess=()=>{const k=c.result;if(k){out[k.key]=k.value;k.continue()}else res(out)};c.onerror=()=>rej(c.error)})}
const ck=x=>(S.lang==='ca'?'ca:':'')+x.toLowerCase();
function setClip(t,blob){if(clipURL[t])URL.revokeObjectURL(clipURL[t]);clipURL[t]=URL.createObjectURL(blob)}
function updateRecInfo(){$('recInfo').textContent=t('recInfo',{k:Object.keys(clipURL).filter(k=>(S.lang==='ca')===(k.indexOf('ca:')===0)).length})}
async function loadClips(){try{const all=await idbAll();Object.entries(all).forEach(([k,b])=>setClip(k,b))}catch(e){}updateRecInfo()}
function playClip(t){
  const u=clipURL[t];if(!u)return false;
  try{if(curAudio)curAudio.pause();curAudio=new Audio(u);curAudio.play().catch(()=>{});return true}catch(e){return false}
}
// Generated clips (see scripts/generate-audio.mjs). audio/manifest.json maps lowercase text -> file, per language.
let genManifest={clips:{es:{},ca:{}}};
async function loadManifest(){
  try{const r=await fetch('audio/manifest.json',{cache:'no-cache'});if(r.ok)genManifest=await r.json()}catch(e){}
}
function genFile(t){const m=(genManifest.clips||{})[S.lang];return m&&m[t.toLowerCase()]}
// ?v=<revision> makes a regenerated or re-recorded clip a new URL, so the service worker (cache-first by URL) fetches it again.
const clipUrl=(lang,key,file)=>{const r=((genManifest.rev||{})[lang]||{})[key];return 'audio/'+lang+'/'+file+(r?'?v='+r:'')};
function ttsSpeak(t){
  if(!hasTTS)return;
  try{
    const u=new SpeechSynthesisUtterance(t);
    u.lang=voice?voice.lang:(S.lang==='ca'?'ca-ES':'es-ES'); if(voice)u.voice=voice; u.rate=S.rate;
    speechSynthesis.speak(u);
  }catch(e){}
}
function playGen(t){
  const f=genFile(t);if(!f)return false;
  try{
    if(curAudio)curAudio.pause();
    curAudio=new Audio(clipUrl(S.lang,t.toLowerCase(),f));
    curAudio.play().catch(()=>ttsSpeak(t));
    return true;
  }catch(e){return false}
}
// Priority: parent's recording (IndexedDB) > generated clip > browser voice.
function say(t){
  try{if(hasTTS)speechSynthesis.cancel()}catch(e){}
  if(playClip(ck(t)))return;
  if(playGen(t))return;
  ttsSpeak(t);
}
// Warm the service-worker cache with all generated clips so the app works offline.
async function warmAudio(){
  try{
    if(!navigator.onLine||!navigator.serviceWorker||!navigator.serviceWorker.controller)return;
    const stamp=genManifest.generated||'';if(!stamp)return;
    const jobs=[];
    Object.keys(genManifest.clips||{}).forEach(l=>Object.entries(genManifest.clips[l]).forEach(([k,f])=>jobs.push(clipUrl(l,k,f))));
    // A service-worker cache bump deletes the old cache, so trust the stamp only while the files are still cached.
    const stillCached=async()=>{try{return !jobs.length||!!(await caches.match(jobs[0]))}catch(e){return true}};
    if(S.warmed===stamp&&await stillCached())return;
    let i=0;
    const worker=async()=>{while(i<jobs.length){const u=jobs[i++];try{await fetch(u)}catch(e){return}}};
    await Promise.all([worker(),worker(),worker()]);
    S.warmed=stamp;save();
  }catch(e){}
}

// ---------- items ----------
const MIN_WORDS=4; // Palabras needs at least this many open words
const pathPos=()=>S.lang==='ca'?S.pathCa:S.pathEs;
const itemsFor=(lv,mode)=>{
  const L=LEVELS[lv];
  return mode==='syl'
    ? L.syl.map(s=>({key:(S.lang==='ca'?'ca:':'')+'s:'+s,parts:splitSyl(s),text:s,emoji:null,h:s,mode:'syl'}))
    : L.words.map(o=>({key:(S.lang==='ca'?'ca:':'')+'w:'+o.w,parts:o.w.split('-'),text:o.w.replace(/-/g,''),emoji:o.e,h:o.w,mode:'word'}));
};
const eligible=i=>LR.stepOf(i.h)<=pathPos();
// Items of levels 0..lv (cumulative) that the open letters allow; may be empty.
const openItems=(mode,lv=S.level)=>{const out=[];for(let l=0;l<=lv;l++)out.push(...itemsFor(l,mode).filter(eligible));return out};
// What the next exercise is drawn from; with nothing open it ignores the letters rather than stall.
const poolFor=mode=>{
  const o=openItems(mode);if(o.length)return o;
  const all=[];for(let l=0;l<=S.level;l++)all.push(...itemsFor(l,mode));return all;
};
const effMode=()=>S.mode==='word'&&openItems('word').length>=MIN_WORDS?'word':'syl'; // the stored preference S.mode is never changed by this
const recent=[]; // keys of the last exercises (not saved)
function pick(){
  const all=poolFor(effMode());
  const k=Math.min(6,Math.floor(all.length/2));
  const skip=new Set(recent.slice(-k));if(last)skip.add(last);
  let pool=all.filter(i=>!skip.has(i.key));
  if(!pool.length)pool=all.filter(i=>!last||i.key!==last||all.length<2);
  if(!pool.length)pool=all;
  const wts=pool.map(i=>{const s=S.stats[i.key]||{ok:0,fail:0};return Math.max(.25,1+s.fail*2.5-s.ok*.35+(s.ok+s.fail===0?1.5:0))});
  let r=Math.random()*wts.reduce((a,b)=>a+b,0),it=pool[0];
  for(let i=0;i<pool.length;i++){r-=wts[i];if(r<=0){it=pool[i];break}}
  recent.push(it.key);if(recent.length>12)recent.shift();
  return it;
}

// ---------- render ----------
function renderLevels(){
  const box=$('levels');box.innerHTML='';
  LEVELS.forEach((L,i)=>{
    const all=[...itemsFor(i,'syl'),...itemsFor(i,'word')].filter(eligible); // only the open items count
    const pct=all.length?Math.round(100*all.filter(x=>mastered(x.key)).length/all.length):0;
    const b=document.createElement('button');
    b.className='level';b.setAttribute('aria-pressed',i===S.level);
    b.innerHTML='<b>'+(i+1)+'. '+L.name+'</b><small>'+L.sub+'</small><div class="bar"><i style="width:'+pct+'%"></i></div>';
    b.onclick=()=>{S.level=i;save();renderLevels();next()};
    box.appendChild(b);
  });
}
function renderHard(){
  const list=Object.entries(S.stats).filter(([k,s])=>s.fail>s.ok&&(S.lang==='ca')===(k.indexOf('ca:')===0)).sort((a,b)=>(b[1].fail-b[1].ok)-(a[1].fail-a[1].ok)).slice(0,10);
  const box=$('hard');box.innerHTML='';
  if(!list.length){box.innerHTML='<span class="small">'+t('hardEmpty')+'</span>';return}
  list.forEach(([k])=>{const c=document.createElement('span');c.className='chip';c.textContent=k.replace(/^ca:/,'').replace(/^(snd|s|w):/,'');box.appendChild(c)});
}
const hintFor=p=>p==='read'
  ? t(((cur&&cur.mode)||effMode())==='syl'?'hintSyl':'hintWord',{n:nm()})
  : t('hintJudge');
// Lumi's instruction sentence: a recording or a generated clip only. The browser voice is robotic, so with no clip he stays silent.
// While it plays his beak moves; tapped (big) he also grows to the middle of the screen.
const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
let talkT=null,rafT=null,jawEls=[],closeGen=0,hintIntro=false,jawV=0,talkCtx=null; // closeGen: opening again cancels a pending close // hintIntro: the first sentence of a session plays by itself, once
const jawSet=v=>jawEls.forEach(e=>e.style.setProperty('--jaw',v));
// The beak follows the real loudness of the clip (Web Audio analyser): closed in silence, wide on loud syllables.
// The audio element is rerouted through the context, so only use it when the context is running (otherwise the clip would be mute).
// The context is created only on a real tap (`tapped`): one made at page load, with no gesture, stays suspended.
function levelMeter(au,tapped){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
    if(!talkCtx){if(!tapped)return null;talkCtx=new AC()}
    if(talkCtx.state!=='running'){if(talkCtx.resume)talkCtx.resume().catch(()=>{});return null}
    const src=talkCtx.createMediaElementSource(au),an=talkCtx.createAnalyser();
    an.fftSize=512;src.connect(an);an.connect(talkCtx.destination);
    const buf=new Uint8Array(an.fftSize);
    return ()=>{an.getByteTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++){const x=(buf[i]-128)/128;s+=x*x}return Math.sqrt(s/buf.length)};
  }catch(e){return null}
}
function voiceLoop(meter){
  const tick=()=>{
    const lv=Math.min(1,Math.max(0,(meter()-.015)*4.5)); // gate the noise floor; speech RMS is about .05-.25
    jawV+=(lv-jawV)*(lv>jawV?.6:.25); // opens fast, closes a bit slower
    jawSet(jawV.toFixed(2));
    rafT=requestAnimationFrame(tick);
  };
  tick();
}
function mouthLoop(){ // fallback with no Web Audio: a calm speech rhythm, open by a random amount then closed
  jawSet((.35+Math.random()*.65).toFixed(2));
  talkT=setTimeout(()=>{jawSet('0');talkT=setTimeout(mouthLoop,90+Math.random()*60)},150+Math.random()*80);
}
function flyTo(art,m){ // place the big Lumi over the small one (translate + scale), without animating
  const r=m.getBoundingClientRect(),b=art.getBoundingClientRect();
  if(!b.width)return;
  art.style.transform='translate('+(r.left+r.width/2-b.left-b.width/2)+'px,'+(r.top+r.height/2-b.top-b.height/2)+'px) scale('+(r.width/b.width)+')';
}
function openBig(text){
  const ov=$('lumiBig'),art=$('lumiBigArt'),m=$('mascot'),still=reducedMotion();
  closeGen++;
  const c=m.cloneNode(true);
  ['id','role','aria-label','data-ia','style'].forEach(a=>c.removeAttribute(a));
  c.setAttribute('class','mascot');c.setAttribute('aria-hidden','true');
  art.innerHTML='';art.appendChild(c);
  $('lumiBigText').textContent=text;
  ov.classList.remove('closing');ov.classList.toggle('still',still);
  art.style.transform='';ov.hidden=false;
  if(!still){art.style.transition='none';flyTo(art,m);art.getBoundingClientRect();art.style.transition='';art.style.transform=''} // grows from his corner
  ov.classList.add('talking');
  return c;
}
function closeBig(){
  const ov=$('lumiBig');if(ov.hidden)return;
  ov.classList.remove('talking');ov.classList.add('closing');
  if(!reducedMotion())flyTo($('lumiBigArt'),$('mascot')); // shrinks back to his corner
  const g=++closeGen;
  setTimeout(()=>{if(g===closeGen){ov.hidden=true;ov.classList.remove('closing')}},reducedMotion()?250:450);
}
function talkStart(big,text,meter){
  talkStop();
  const m=$('mascot');jawEls=[m];
  if(big)jawEls=[openBig(text)];else m.classList.add('talking');
  if(meter)voiceLoop(meter);else mouthLoop();
}
function talkStop(){
  clearTimeout(talkT);cancelAnimationFrame(rafT);jawV=0;jawSet('0');jawEls=[];
  $('mascot').classList.remove('talking');
  closeBig();
}
function hintAudio(x){
  const u=clipURL[ck(x)];if(u)return new Audio(u);
  const f=genFile(x);return f?new Audio(clipUrl(S.lang,x.toLowerCase(),f)):null;
}
// Plays a clip or recording of `x` with Lumi talking (big = he comes to the middle of the screen). False if there is neither.
function lumiPlay(x,big){
  const au=hintAudio(x);if(!au)return false;
  try{
    if(curAudio)curAudio.pause();curAudio=au;
    talkStart(big,x,levelMeter(au,big));
    const done=()=>{if(curAudio===au)talkStop()};
    au.onended=au.onerror=done;
    au.play().catch(done);
    return true;
  }catch(e){talkStop();return false}
}
function sayHint(big){return phase!=='read'&&phase!=='judge'?false:lumiPlay(hintFor(phase),big)}
// His praise (after an answer, a sticker, the end of a session): he comes big; with no clip it falls back to the browser voice, as before.
function sayLumi(x){
  try{if(hasTTS)speechSynthesis.cancel()}catch(e){}
  if(!lumiPlay(x,true))ttsSpeak(x);
}
// Only counts as said once a clip really played (the manifest may still be loading when the first exercise appears).
function introHint(){if(sDone===0&&!hintIntro&&phase==='read'&&sayHint(false))hintIntro=true}
function setPhase(p){
  phase=p;
  $('joinBtn').hidden=p!=='read';
  ['hearBtn','okBtn','noBtn'].forEach(id=>$(id).hidden=p!=='judge');
  $('hint').textContent=hintFor(p);
}
function show(){
  const it=cur, t=$('tiles');
  t.classList.remove('merged');t.innerHTML='';
  const w=Math.min(window.innerWidth,660)*.86;
  const fs=Math.max(44,Math.min(130,Math.floor(w/(it.text.length*.62+it.parts.length*.5+.4))));
  t.style.setProperty('--fs',fs+'px');
  it.parts.forEach((p,i)=>{
    const b=document.createElement('button');
    b.className='tile c'+(i%5)+(it.mode==='syl'?' static':'');
    b.textContent=p;
    b.setAttribute('aria-label',p);
    if(it.mode==='word') b.onclick=()=>say(p);
    t.appendChild(b);
  });
  const pic=$('pic');
  pic.hidden=it.mode!=='word'||!it.emoji; // a word without a picture (e.g. "no", "dia") has no slot at all
  pic.className='pic q';pic.textContent='?';
  setPhase('read');
  introHint();
}
const worldNow=()=>S.world==='auto'?curWorld:Math.min(S.world,WORLDS.length-1);
function newWorld(){if(S.world==='auto')curWorld=(curWorld+1)%WORLDS.length}
function renderWorlds(){
  const g=$('worldGrid');g.innerHTML='';
  const have=w=>Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length);
  const mk=(val,icon,label,w)=>{
    const b=document.createElement('button');b.className='wbtn';b.setAttribute('aria-pressed',S.world===val);
    if(w)b.style.background='linear-gradient(165deg,color-mix(in srgb,'+w.a+' 55%,var(--panel)),color-mix(in srgb,'+w.b+' 40%,var(--panel)))';
    const n=w?have(w):stkTotal(),of=w?w.stk.length:WORLDS.reduce((s,x)=>s+x.stk.length,0);
    b.innerHTML='<span>'+icon+'</span>'+label+'<small class="wk">'+n+'/'+of+(n===of?' ✓':'')+'</small>';
    b.setAttribute('aria-label',label+', '+t('worldProg',{n:n,t:of}));
    b.onclick=()=>{S.world=val;save();renderWorlds();applyWorld();$('worlds').hidden=true};
    g.appendChild(b);
  };
  mk('auto','🎲',t('worldAuto'),null);
  WORLDS.forEach((w,i)=>mk(i,w.icon,wn(w),w));
}
function applyWorld(){
  const w=WORLDS[worldNow()],st=$('stage');
  st.style.setProperty('--wa',w.a);st.style.setProperty('--wb',w.b);st.style.setProperty('--deco','"'+w.deco+'"');
}
function next(){
  if(resting){resting=false;sDone=sOk=sStk=0;newWorld();renderSession()}
  applyWorld();
  cur=pick();last=cur.key;show();
  document.getElementById('stage').classList.toggle('upper',S.upper);
  $('tiles').classList.toggle('upper',S.upper);
}
function join(){
  if(phase!=='read')return;
  sfx.join();
  $('tiles').classList.add('merged');
  if(cur.emoji){const p=$('pic');p.className='pic on';p.textContent=cur.emoji}
  say(cur.text);
  setPhase('judge');
}
function burst(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const st=$('stage');
  for(let i=0;i<5;i++){
    const s=document.createElement('span');s.className='star';s.textContent='⭐';
    s.style.left=(20+Math.random()*60)+'%';s.style.animationDelay=(i*70)+'ms';
    st.appendChild(s);setTimeout(()=>s.remove(),1200);
  }
}
// A sticker goes to the set of the world being played; a complete set passes it to the first incomplete world (none when all are done).
let rewardFrom=''; // '<icon> <name>' of the world the last sticker came from when it was not the one being played
function earnSticker(){
  const playing=WORLDS[worldNow()];
  const room=w=>(Math.floor(Number(S.stk[w.id]))||0)<w.stk.length;
  const w=room(playing)?playing:WORLDS.find(room);
  if(!w)return null;
  const n=Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length)+1;
  S.stk[w.id]=n;S.stickers=stkTotal();
  rewardFrom=w===playing?'':w.icon+' '+wn(w);
  return w.stk[n-1];
}
function record(ok){
  if(phase!=='judge')return;
  phase='wait';
  ['hearBtn','okBtn','noBtn'].forEach(id=>$(id).hidden=true);
  const s=stat(cur.key);ok?s.ok++:s.fail++;
  if(ok){
    S.total++;
    burst();sfx.ok();poke('cheer',900);sparkleBurst($('mascot'),10);
    const tl=$('tiles');tl.classList.remove('win');void tl.getBoundingClientRect();tl.classList.add('win');
    setTimeout(()=>tl.classList.remove('win'),700);
  }else{sfx.retry();poke('tilt',800)}
  sDone++;hintIntro=false;if(ok)sOk++;
  const finished=sDone>=S.sessionLen;
  let reward=null;
  if(finished){reward=earnSticker();if(reward)sStk++}
  save();
  renderSession();renderGoal();
  const msg=fmt(rnd(t(ok?'oks':'nos')));
  $('hint').textContent=msg;
  if(reward){
    setTimeout(()=>showReward(reward),500);
    pendingEnd=true;
  }else if(S.sound&&(!ok||Math.random()<.6)){
    setTimeout(()=>sayLumi(msg),200);
  }
  renderLevels();renderHard();renderAlbum();
  if(finished){if(!reward)setTimeout(showEnd,ok?1100:900)}
  else setTimeout(next,ok?1100:900);
}

// ---------- accounts and sync (optional; spec: docs/superpowers/specs/2026-10-17-accounts-sync-design.md) ----------
let sync=null,mergeMod=null,syncBusy=false,syncTimer=null,syncState='idle'; // idle | syncing | offline | error
const AUTH_USER_KEY='leemos-auth-user',SYNC_AT_KEY='leemos-sync-at';
const uuid=()=>(window.crypto&&crypto.randomUUID)?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)});
// Loads the sync modules only when the config has a project; with an empty config nothing is loaded and no request is made.
let syncP=null; // the one pending or finished init, so two calls at once never create two clients or register the listeners twice
function syncInit(){
  if(sync)return Promise.resolve(sync);
  return syncP||(syncP=(async()=>{
    try{
      const cfg=await loadJSON('src/data/sync.config.json',{cache:'no-cache'}); // revalidate: the host caches files for minutes and a stale empty config would hide the login
      if(!cfg||!cfg.url||!cfg.anonKey)return null;
      const imp=window.__leemosImport||(p=>import(p));
      const [sm,mm]=await Promise.all([imp('./sync.js'),imp('./merge.js')]);
      mergeMod=mm;
      sync=sm.createSync({url:cfg.url,anonKey:cfg.anonKey,fetch:window.__leemosSyncFetch||undefined,storage:localStorage}); // the page's own localStorage, also under the jsdom tests
      // Push when the page is hidden or closing; PULL what other devices did when it is shown again, focused, back online,
      // and once a minute while it stays visible (an open page never asks the server by itself otherwise).
      const wake=()=>{if(!document.hidden)syncAll()};
      document.addEventListener('visibilitychange',()=>{document.hidden?syncAll():wake()});
      window.addEventListener('pagehide',()=>syncAll());
      window.addEventListener('focus',wake);
      window.addEventListener('online',()=>syncAll());
      setInterval(wake,window.__leemosSyncEvery||60000);
      return sync;
    }catch(err){syncP=null;return null} // a failed load can be retried later
  })());
}
const stateOf=id=>{
  if(id===PROFILE.id)return S;
  try{return JSON.parse(localStorage.getItem(keyFor(id)))||{}}catch(e){return {}}
};
// Write merged data into a profile (the active one lives in S; the others only in localStorage).
const IDLE_MS=30000; // a value changed on THIS device within the last 30 s is kept: nobody is interrupted while playing
function applyMerged(m,adoptSession){
  const before={lang:S.lang,mode:S.mode,world:S.world,sessionLen:S.sessionLen,pos:pathPos()};
  mergeMod.applySynced(S,m); // sets the progress fields, S.session, S.prefs and the plain preference fields (never the voice)
  S.stickers=stkTotal(); // the merge caps a world at 24 and keeps unknown worlds; the counter must follow the sets that exist
  if(S.lang!==before.lang){LEVELS=LV[S.lang]||LV_ES;pendingEnd=false;resting=false}
  if(S.level>=LEVELS.length)S.level=0;
  // preferences, through the same functions the UI uses
  applyTheme();applyCase();applySound();applyWorld();
  $('rate').value=S.rate;$('sessionSel').value=String(S.sessionLen);
  renderMode();
  // the session in progress: a finished or stale one starts a new session
  const s=m.session;
  if(adoptSession&&s.at){
    if(isFresh(s.at,SESSION_TTL)&&s.done<S.sessionLen){sDone=s.done;sOk=s.ok;sStk=s.stk}
    else{sDone=sOk=sStk=0}
  }
  lastFp=fpOf();lastSessFp=sessFp();lastPref=prefSnap(); // data that came from the server is not a local change: no stamps, no new sync
  // a shorter session length from another device must not leave a protected session at or above it (it would count as finished)
  if(!adoptSession&&S.sessionLen!==before.sessionLen&&sDone>=S.sessionLen){sDone=Math.max(0,S.sessionLen-1);sOk=Math.min(sOk,sDone);sStk=Math.min(sStk,sDone)} // after the baselines: this IS a local change, so save() stamps it
  save();renderLevels();renderPath();renderMode();renderHard();renderAlbum();updateHello();
  if(S.lang!==before.lang)applyLang();else renderSession();
  renderGoal();
  if(S.world!==before.world)renderWorlds(); // not on every pull: it would replace the buttons (and the focus) of an open worlds overlay
  if(S.lang!==before.lang||((S.mode!==before.mode||pathPos()!==before.pos)&&!resting))pre?pre.refresh():next(); // while resting, next() would start (and stamp) a new session // a different context needs a new exercise; otherwise the card on screen stays
}
// Returns the merged data. The child may have answered while the request was in flight, so the server's data is merged
// into the CURRENT local state (never copied over it): a sync can only add progress, never take it away.
function storeState(id,data){
  const active=id===PROFILE.id,cur=active?S:stateOf(id);
  const mine=mergeMod.pickSynced(cur);
  const merged=mergeMod.mergeData(mine,data);
  if(active){
    const now=Date.now();
    for(const k of PREF_KEYS){ // keep what was changed here a moment ago; renewing its stamp makes it win on the next push
      const m=mine.prefs[k];
      if(m&&isFresh(m.at,IDLE_MS)&&(!merged.prefs[k]||merged.prefs[k].at!==m.at))merged.prefs[k]={v:m.v,at:Math.max(now,(merged.prefs[k]?merged.prefs[k].at:0)+1)}; // the renewed stamp must beat the one it overrides
    }
    // the language is never switched under an open recorder: recordings are stored under the current language's keys
    if(RS.on||!$('recorder').hidden){
      const m=mine.prefs.lang;
      if(m)merged.prefs.lang={v:m.v,at:Math.max(now,(merged.prefs.lang?merged.prefs.lang.at:0)+1)};else delete merged.prefs.lang;
    }
    let adopt=true; // whether the merged session replaces this device's counters
    if(mine.session.at&&isFresh(mine.session.at,IDLE_MS)&&merged.session.at!==mine.session.at){merged.session={...mine.session,at:Math.max(now,merged.session.at+1)};adopt=false}
    if(merged.session.at===mine.session.at)adopt=false; // the merged session is this device's own (the echo of its own push): nothing to adopt
    if(pendingEnd||!$('reward').hidden||!$('end').hidden)adopt=false; // the end of a session is on screen: its counters feed the end screen
    applyMerged(merged,adopt);
  }else{
    mergeMod.applySynced(cur,merged);
    try{localStorage.setItem(keyFor(id),JSON.stringify(cur))}catch(e){}
  }
  return merged;
}
function schedSync(){if(!sync)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncAll(),5000)}
onProgressChange=schedSync;
async function syncAll(){
  if(syncBusy||!sync)return;
  syncBusy=true; // before the first await: two triggers at once (visibilitychange + pagehide, a double tap) must run ONE sync
  try{
    let s=null;
    try{s=await sync.session()}catch(e){renderAcct();return}
    if(!s)return;
    let last=null;try{last=localStorage.getItem(AUTH_USER_KEY)}catch(e){}
    if(last&&s.user&&s.user.id&&last!==s.user.id)return; // a session of another account than the one this device was linked to: never send these profiles to it
    syncState='syncing';renderAcct();
    const rank=k=>k==='auth'?3:k==='offline'?1:2;
    let worst=null,again=false;
    for(const p of PROFILES.list){
      if(!p.rid)continue;
      try{
        const r=await sync.syncProfile({rid:p.rid,name:p.name,kind:p.kind,data:mergeMod.pickSynced(stateOf(p.id))});
        const merged=storeState(p.id,r.data);
        if(!mergeMod.sameData(merged,r.data))again=true; // the child progressed meanwhile: push that too
      }catch(e){const k=e&&e.kind||'error';if(!worst||rank(k)>rank(worst))worst=k} // one profile failing must not stop the others
    }
    if(worst){syncState=worst==='offline'?'offline':'error';if(worst==='auth')acctMsg('acctExpired')}
    else{syncState='idle';try{localStorage.setItem(SYNC_AT_KEY,String(Date.now()))}catch(e){}}
    if(again)schedSync();
  }finally{syncBusy=false;renderAcct()}
}
function acctMsg(key,vars){$('acctMsg').textContent=key?t(key,vars):''}
function renderAcct(){
  if(!sync)return;
  $('acct').hidden=false;
  let email='';try{const s=JSON.parse(localStorage.getItem('leemos-auth'));email=s&&s.user&&s.user.email||''}catch(e){}
  const signedIn=!!email&&!!sync.userId();
  $('acctOut').hidden=signedIn;$('acctIn').hidden=!signedIn;
  if(!signedIn)return;
  $('acctWho').textContent=t('acctWho',{e:email});
  let at=0;try{at=Number(localStorage.getItem(SYNC_AT_KEY))||0}catch(err){}
  const mins=Math.max(0,Math.round((Date.now()-at)/60000));
  $('acctStatus').textContent=syncState==='syncing'?t('acctSyncing'):syncState==='offline'?t('acctOffline'):!at?t('acctNever'):t('acctSynced',{m:mins<1?t('acctJustNow'):t('acctMinAgo',{n:mins})});
}
$('parents').addEventListener('toggle',async()=>{if($('parents').open&&await syncInit())renderAcct()});
$('acctSend').onclick=async()=>{
  const email=$('acctEmail').value.trim();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){acctMsg('acctBadEmail');return}
  if(!$('acctConsent').checked){acctMsg('acctNeedConsent');return}
  const sy=await syncInit();if(!sy)return;
  try{await sy.requestCode(email);$('acctCodeRow').hidden=false;acctMsg('acctSent');$('acctCode').focus()}
  catch(e){acctMsg(e&&e.kind==='offline'?'acctNetwork':'acctError')}
};
$('acctVerify').onclick=async()=>{
  const sy=await syncInit();if(!sy)return;
  try{
    const s=await sy.verifyCode($('acctEmail').value.trim(),$('acctCode').value);
    acctMsg('');$('acctCode').value='';$('acctCodeRow').hidden=true;
    await afterSignIn(s.user);
  }catch(e){acctMsg(e&&e.kind==='code'?'acctBadCode':e&&e.kind==='offline'?'acctNetwork':'acctError')}
};
$('acctSync').onclick=()=>syncAll();
$('acctOutBtn').onclick=()=>{if(sync)sync.signOut();syncState='idle';acctMsg('');renderAcct()};
// Asks which account profile (if any) a local profile is. Resolves with a remote id, or null for "add as a new child".
// Closing the dialog ("Ahora no") rejects, and the caller leaves everything as it was.
const remoteName=r=>typeof(r&&r.name)==='string'?r.name.trim().slice(0,20):''; // account data is untrusted: only a real, short string is a name
function askLink(local,candidates){
  return new Promise((resolve,reject)=>{
    $('linkAsk').textContent=t('linkAsk',{n:local.name});
    const box=$('linkOpts');box.innerHTML='';
    const onKey=e=>{if(e.key==='Escape')done(undefined)};
    const done=v=>{document.removeEventListener('keydown',onKey);$('link').hidden=true;v===undefined?reject(new Error('cancelled')):resolve(v)};
    candidates.forEach(r=>{const b=document.createElement('button');b.className='wbtn';b.textContent=remoteName(r)||'?';b.onclick=()=>done(r.id);box.appendChild(b)});
    const nb=document.createElement('button');nb.className='wbtn';nb.textContent=t('linkNew');nb.onclick=()=>done(null);box.appendChild(nb);
    $('linkCancel').onclick=()=>done(undefined);
    document.addEventListener('keydown',onKey);
    $('link').hidden=false;
    box.firstChild.focus();
  });
}
// First sign-in on this device (spec section 4): link the local profiles to the account's, upload the new ones, bring the rest here.
async function afterSignIn(user){
  let prev=null;try{prev=localStorage.getItem(AUTH_USER_KEY)}catch(err){}
  const snapshot=JSON.stringify(PROFILES.list);
  try{
    if(prev&&prev!==user.id)PROFILES.list.forEach(p=>{delete p.rid}); // another account used this tablet: never upload its children into this one unasked
    const remote=await sync.listProfiles();
    const known=new Set(remote.map(r=>r.id));
    const claimed=new Set(PROFILES.list.filter(p=>p.rid&&known.has(p.rid)).map(p=>p.rid));
    for(const p of PROFILES.list.filter(x=>!x.rid)){
      const cands=remote.filter(r=>!claimed.has(r.id)&&r.kind===p.kind); // only a child of the same kind can be the same child
      const pick=cands.length?await askLink(p,cands):null;
      p.rid=pick||uuid();
      if(pick){claimed.add(pick);const rn=remoteName(remote.find(r=>r.id===pick));if(rn)p.name=rn} // the account's name is the one that follows the child
    }
    for(const r of remote){
      if(claimed.has(r.id)||PROFILES.list.some(p=>p.rid===r.id))continue;
      const rn=remoteName(r);
      if(!rn)continue; // a remote row without a usable name is skipped, never allowed to break the linking
      const base=profileSlug(rn)||'nino';let id=base,i=2;
      while(PROFILES.list.some(x=>x.id===id)||localStorage.getItem(keyFor(id))!==null)id=base+'-'+i++; // never reuse a storage key that already holds something
      PROFILES.list.push({id,name:rn,kind:r.kind==='pre'?'pre':'reader',rid:r.id});
      const st=mergeMod.applySynced({},r.data);
      try{localStorage.setItem(keyFor(id),JSON.stringify(st))}catch(err){}
    }
    if(!saveProfiles())throw new Error('storage'); // if the list cannot be saved the links would be lost at the next load: undo, do not pretend
    try{localStorage.setItem(AUTH_USER_KEY,user.id)}catch(err){}
  }catch(e){
    // cancelled or failed half way: nothing stays linked and the device is signed out again. The list is restored in place,
    // so PROFILE (the active entry) is still one of its objects and renaming the child keeps persisting.
    const keep=JSON.parse(snapshot);
    for(let i=PROFILES.list.length-1;i>=0;i--)if(!keep.some(k=>k.id===PROFILES.list[i].id))PROFILES.list.splice(i,1);
    PROFILES.list.forEach(p=>{const k=keep.find(x=>x.id===p.id);delete p.rid;if(k&&k.rid)p.rid=k.rid;if(k)p.name=k.name});
    sync.signOut();syncState='idle';
    $('link').hidden=true;
    acctMsg(e&&e.kind==='offline'?'acctNetwork':e&&e.message==='cancelled'?'':'acctError');
    renderAcct();
    return;
  }
  await syncAll();
}
// A session from an earlier visit: sync at start (only if signed in; otherwise nothing is loaded or sent).
try{if(localStorage.getItem('leemos-auth'))syncInit().then(sy=>{if(sy){renderAcct();syncAll()}})}catch(e){}

// ---------- mascot, sound, rewards ----------
const MASCOT_STATES=['cheer','tilt','dance','antic-look','antic-stretch','antic-wave'];
let lastActivity=Date.now();
function markActivity(){lastActivity=Date.now()}
function poke(cls,ms){
  markActivity();
  const m=$('mascot');
  m.classList.remove(...MASCOT_STATES);
  void m.getBoundingClientRect();
  m.classList.add(cls);
  setTimeout(()=>m.classList.remove(cls),ms);
}
document.addEventListener('pointerdown',markActivity,{passive:true});
document.addEventListener('keydown',markActivity);
setInterval(()=>{
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(document.hidden)return;
  const m=$('mascot');
  if(!m||MASCOT_STATES.some(c=>m.classList.contains(c)))return;
  if(!$('reward').hidden||!$('end').hidden||!$('album').hidden||!$('worlds').hidden)return;
  if(Date.now()-lastActivity<7000+Math.random()*6000)return;
  const antics=['antic-look','antic-stretch','antic-wave'];
  poke(antics[Math.floor(Math.random()*antics.length)],1100);
},4000);
let AC=null;
function tone(freqs,dur,type,vol){
  if(!S.sound)return;
  try{
    AC=AC||new (window.AudioContext||window.webkitAudioContext)();
    if(AC.state==='suspended')AC.resume();
    const t0=AC.currentTime;
    freqs.forEach((f,i)=>{
      const o=AC.createOscillator(),g=AC.createGain(),st=t0+i*dur;
      o.type=type;o.frequency.value=f;o.connect(g);g.connect(AC.destination);
      g.gain.setValueAtTime(0,st);
      g.gain.linearRampToValueAtTime(vol,st+.02);
      g.gain.exponentialRampToValueAtTime(.0001,st+dur*1.6);
      o.start(st);o.stop(st+dur*1.7);
    });
  }catch(e){}
}
const sfx={
  join:()=>tone([440,587],.07,'triangle',.1),
  ok:()=>tone([523,659,784],.1,'sine',.18),
  retry:()=>tone([392,349],.14,'triangle',.12),
  win:()=>tone([523,659,784,880,1047,1175,1319,1568],.09,'sine',.17)
};
function confetti(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const cols=['#FFC53D','#FF4D6D','#8A3FFC','#00C2B8','#2F9BFF','#FF8FC7','#FFE45C'];
  for(let i=0;i<110;i++){
    const b=document.createElement('i');b.className='bit'+(Math.random()<.4?' round':'');
    const sz=10+Math.random()*14;
    b.style.left=Math.random()*100+'vw';
    b.style.background=cols[i%cols.length];
    b.style.width=sz+'px';b.style.height=(sz*1.4)+'px';
    b.style.setProperty('--dx',(Math.random()*220-110)+'px');
    b.style.animationDelay=(Math.random()*.4)+'s';
    b.style.animationDuration=(1.3+Math.random()*.9)+'s';
    document.body.appendChild(b);setTimeout(()=>b.remove(),2800);
  }
}
function sparkleBurst(el,count){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches||!el)return;
  const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  for(let i=0;i<count;i++){
    const s=document.createElement('i');s.className='spark';s.textContent='✨';
    const ang=(Math.PI*2*i/count)+Math.random()*.4,dist=60+Math.random()*80;
    s.style.left=cx+'px';s.style.top=cy+'px';
    s.style.setProperty('--dx',(Math.cos(ang)*dist).toFixed(1)+'px');
    s.style.setProperty('--dy',(Math.sin(ang)*dist).toFixed(1)+'px');
    s.style.animationDelay=(Math.random()*.15)+'s';
    document.body.appendChild(s);setTimeout(()=>s.remove(),1000);
  }
}
function flash(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const f=document.createElement('div');f.className='flash';
  document.body.appendChild(f);setTimeout(()=>f.remove(),550);
}
function renderGoal(n){
  const total=S.sessionLen,k=n===undefined?sDone:n,g=$('goal');g.innerHTML='';
  for(let i=0;i<total;i++){const d=document.createElement('i');if(i<k)d.className='on';g.appendChild(d)}
}
function renderAlbum(){
  $('albumCount').textContent=S.stickers;
  const g=$('stickerGrid');g.innerHTML='';
  let all=0;
  WORLDS.forEach(w=>{
    const own=Math.min(Math.max(0,Math.floor(Number(S.stk[w.id]))||0),w.stk.length);all+=w.stk.length;
    const h=document.createElement('h3');h.className='sset-h';h.textContent=w.icon+' '+wn(w)+' '+own+'/'+w.stk.length;
    h.setAttribute('aria-label',wn(w)+', '+t('worldProg',{n:own,t:w.stk.length}));g.appendChild(h);
    const row=document.createElement('div');row.className='sset';
    w.stk.forEach((e,i)=>{
      const d=document.createElement('div');
      d.className='sticker'+(i<own?'':' locked');
      d.textContent=e;
      d.setAttribute('aria-label',i<own?t('albumGot',{e:e}):t('albumLocked'));
      row.appendChild(d);
    });
    g.appendChild(row);
  });
  $('albumInfo').textContent=t('albumInfo',{s:S.stickers,t:all,x:S.total});
}
function showReward(e){
  $('rewardEmoji').textContent=e;
  const rf=$('rewardFrom');rf.hidden=!rewardFrom;rf.textContent=rewardFrom?t('rewardFrom',{w:rewardFrom}):'';
  $('rewardTitle').textContent=t('rewardTitle',{n:nm()});
  $('reward').hidden=false;
  confetti();sfx.win();flash();poke('dance',1600);
  sparkleBurst($('rewardEmoji'),18);
  if(S.sound)sayLumi(t('rewardTitle',{n:nm()}));
  $('rewardOk').focus();
}
function closeOverlays(){
  const wasReward=!$('reward').hidden, wasEnd=!$('end').hidden;
  $('reward').hidden=true;$('album').hidden=true;$('end').hidden=true;$('worlds').hidden=true;$('profiles').hidden=true;closeRec();
  if(wasReward&&pendingEnd){pendingEnd=false;setTimeout(showEnd,250)}
  else if(wasEnd)restState();
}
function renderSession(){
  const n=S.sessionLen,d=Math.min(sDone,n);
  $('sfill').style.width=Math.round(100*d/n)+'%';
  $('slabel').textContent=t('recOf',{i:d,n:n});
  const b=$('sbar');b.setAttribute('aria-valuemax',n);b.setAttribute('aria-valuenow',d);
  save(); // persists the session counters wherever they are reset or advanced
}
function showEnd(){
  const n=S.sessionLen;
  $('endTitle').textContent=t('endTitle',{n:nm()});
  $('endInfo').textContent=t(pre?'preEndInfo':'endInfo',{o:sOk,n:n})+(sStk?(sStk===1?t('endOne'):t('endMany',{k:sStk})):'');
  $('end').hidden=false;
  let canLevelUp;
  $('endPath').hidden=true;
  if(pre)canLevelUp=pre.showEnd();
  else{
    const opened=advancePath();
    $('endPath').hidden=!opened;
    if(opened)$('endPath').textContent=opened>=12?t('endAllLetters'):t('endNewLetter',{l:LR.STEPS[opened-1].toUpperCase()});
    const all=[...itemsFor(S.level,'syl'),...itemsFor(S.level,'word')].filter(eligible);
    const pct=all.length?Math.round(100*all.filter(x=>mastered(x.key)).length/all.length):0;
    canLevelUp=pathPos()>=12&&pct>=90&&S.level<LEVELS.length-1; // the next level only when every letter is open
    $('endLevelUp').hidden=!canLevelUp;
    $('endLevelUpBtn').hidden=!canLevelUp;
    if(canLevelUp)$('endLevelUp').textContent=t('endLevelUp',{n:S.level+2,t:LEVELS[S.level+1].name});
  }
  confetti();sfx.win();flash();poke('dance',1600);
  if(S.sound)sayLumi(t('endTitle',{n:nm()}));
  (canLevelUp&&!pre?$('endLevelUpBtn'):$('endMore')).focus();
}
function restState(){
  resting=true;cur=null;phase='wait';
  $('tiles').innerHTML='';$('pic').hidden=true;
  $('joinBtn').hidden=true;
  ['hearBtn','okBtn','noBtn'].forEach(id=>$(id).hidden=true);
  $('hint').textContent=t('rest',{n:nm()});
  if(pre)pre.rest();
}
function updateHello(){$('hello').textContent=t('hello',{n:nm()})}
function applySound(){
  $('soundBtn').setAttribute('aria-pressed',S.sound);
  $('soundBtn').textContent=S.sound?'🔔':'🔕';
}

// ---------- wiring ----------
$('joinBtn').onclick=join;
$('hearBtn').onclick=()=>say(cur.text);
$('okBtn').onclick=()=>record(true);
$('noBtn').onclick=()=>record(false);
$('mSyl').onclick=()=>setMode('syl');
$('mWord').onclick=()=>setMode('word');
function renderMode(){
  const m=effMode(),ok=openItems('word').length>=MIN_WORDS;
  $('mSyl').setAttribute('aria-pressed',m==='syl');$('mWord').setAttribute('aria-pressed',m==='word');
  $('mWord').setAttribute('aria-disabled',!ok);$('mWord').classList.toggle('dim',!ok);$('mWord').title=ok?'':t('wordsLocked');
}
function setMode(m){
  if(m==='word'&&openItems('word').length<MIN_WORDS)return; // dimmed: not enough words are open yet
  S.mode=m;save();
  renderMode();
  next();
}
// The parent's block and the automatic rule (spec: 2026-10-17-elsas-path-design.md). Both go through setPath, which saves (and so stamps) the preference.
function renderPath(){
  const row=$('pathRow');row.innerHTML='';const pos=pathPos();
  LR.STEPS.forEach((l,i)=>{
    const name=l==='*'?t('pathRest'):l.toUpperCase();
    const b=document.createElement('button');
    b.textContent=name;b.className=i<pos?'':'closed';b.setAttribute('aria-pressed',i===pos-1);
    b.setAttribute('aria-label',name+', '+t(i<pos?'pathOpen':'pathClosed'));
    b.onclick=()=>setPath(i+1);
    row.appendChild(b);
  });
  $('pathAuto').checked=!!S.pathAuto;
}
function setPath(n){
  n=Math.max(1,Math.min(12,n|0));
  if(S.lang==='ca')S.pathCa=n;else S.pathEs=n;
  save();renderPath();renderMode();renderLevels();
}
$('pathAuto').onchange=()=>{S.pathAuto=$('pathAuto').checked;save()};
// After a session: the next letter opens when at least 75% of the items the current letter just made available are mastered (or there are none).
function advancePath(){
  const pos=pathPos();
  if(!S.pathAuto||pos>=12)return 0;
  const fresh=[...openItems('syl'),...openItems('word')].filter(i=>LR.stepOf(i.h)===pos);
  if(fresh.length&&fresh.filter(i=>mastered(i.key)).length/fresh.length<.75)return 0;
  setPath(pos+1);return pos+1;
}
$('caseBtn').onclick=()=>{S.upper=!S.upper;save();applyCase()};
function applyCase(){
  $('caseBtn').setAttribute('aria-pressed',S.upper);
  $('caseBtn').textContent=S.upper?'AA':'Aa';
  document.body.classList.toggle('upper',S.upper);
  $('tiles').classList.toggle('upper',S.upper);
}
$('rate').value=S.rate;
$('rate').oninput=e=>{S.rate=parseFloat(e.target.value);save()};
$('testVoice').onclick=()=>say(t('sample'));
$('resetBtn').onclick=e=>{
  if(!resetArmed){resetArmed=true;e.target.textContent=t('sure');setTimeout(()=>{resetArmed=false;e.target.textContent=t('resetBtn')},3500);return}
  Object.keys(S.stats).forEach(k=>{if((S.lang==='ca')===(k.indexOf('ca:')===0))delete S.stats[k]});S.resets=Object.assign({es:0,ca:0},S.resets);S.resets[S.lang]=(S.resets[S.lang]||0)+1;save();resetArmed=false;e.target.textContent=t('resetBtn');renderLevels();renderHard();pre?pre.refresh():next();
};
function applyTheme(){
  if(S.theme)document.documentElement.setAttribute('data-theme',S.theme);
  else document.documentElement.removeAttribute('data-theme');
}
$('themeBtn').onclick=()=>{
  const dark=document.documentElement.getAttribute('data-theme')==='dark'||(!S.theme&&matchMedia('(prefers-color-scheme: dark)').matches);
  S.theme=dark?'light':'dark';save();applyTheme();
};
window.addEventListener('resize',()=>{if(cur){const merged=$('tiles').classList.contains('merged');const ph=phase;show();if(merged&&ph==='judge'){$('tiles').classList.add('merged');setPhase('judge');if(cur.emoji){$('pic').className='pic on';$('pic').textContent=cur.emoji}}}});

renderMode();
$('albumBtn').onclick=()=>{renderAlbum();$('album').hidden=false;$('albumClose').focus({preventScroll:true})}; // the long album must open at the top, not scrolled to the close button
$('albumClose').onclick=closeOverlays;
$('worldBtn').onclick=()=>{renderWorlds();$('worlds').hidden=false;$('worldsClose').focus()};
$('worldsClose').onclick=closeOverlays;
function updateProfileChip(){$('profileName').textContent=PROFILE.name}
function renderProfiles(){
  const g=$('profileList');g.innerHTML='';
  PROFILES.list.forEach(p=>{
    const b=document.createElement('button');
    b.className='wbtn';b.setAttribute('aria-pressed',p.id===PROFILES.active);
    const ic=document.createElement('span');ic.textContent=p.kind==='pre'?'🔤':'📖';
    b.append(ic,document.createTextNode(p.name));
    b.onclick=()=>{if(p.id!==PROFILES.active)switchProfile(p.id);else closeOverlays()};
    g.appendChild(b);
  });
}
function openProfiles(){renderProfiles();$('profiles').hidden=false;$('profilesClose').focus()}
$('profileBtn').onclick=openProfiles;
$('profileOpen').onclick=openProfiles;
$('profilesClose').onclick=closeOverlays;
$('pfAdd').onclick=()=>{const n=$('pfName').value.trim();if(n)addProfile(n,$('pfKind').value)};
$('rewardOk').onclick=closeOverlays;
['album','reward','worlds','profiles'].forEach(id=>$(id).addEventListener('click',e=>{if(e.target.id===id)closeOverlays()}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOverlays()});
$('soundBtn').onclick=()=>{S.sound=!S.sound;save();applySound();if(S.sound)sfx.ok()};
$('nm').value=S.name;
$('nm').oninput=e=>{
  S.name=e.target.value;save();updateHello();
  const pn=S.name.trim();if(pn){PROFILE.name=pn;saveProfiles();updateProfileChip()}
  if(phase==='read'||phase==='judge')$('hint').textContent=hintFor(phase);
};

// ---------- recorder (parent's voice) ----------
const RS={list:[],i:0,on:false};
let rec=null,recChunks=[],recStream=null;
function recItems(lv){
  const L=LEVELS[lv],set=new Set(L.syl);
  L.words.forEach(o=>o.w.split('-').forEach(p=>set.add(p)));
  L.words.forEach(o=>set.add(o.w.replace(/-/g,'')));
  return [...set];
}
// Live level bar + silence check: a clip whose loudest sample stays below SILENT_PEAK (about -40 dBFS) is not saved,
// because the usual cause is the browser opening the wrong microphone (e.g. Bluetooth headphones) or a zero input volume.
const SILENT_PEAK=0.01;
// "Silent" needs evidence: only readings taken while the AudioContext was running count (browsers may leave it suspended,
// and an analyser without getFloatTimeDomainData reads nothing), so a recording is rejected only after >= 2 real readings.
let recPeak=1,meterTicks=0,meterOn=false,meterRaf=0,meterSrc=null;
function startMeter(){
  recPeak=1; // unknown until an analyser works: never call a recording silent without evidence
  try{
    AC=AC||new (window.AudioContext||window.webkitAudioContext)();
    if(AC.state==='suspended')AC.resume();
    meterSrc=AC.createMediaStreamSource(recStream);
    const an=AC.createAnalyser();an.fftSize=1024;meterSrc.connect(an);
    const buf=new Float32Array(an.fftSize);
    recPeak=0;meterTicks=0;meterOn=true;
    const tick=()=>{
      try{
        an.getFloatTimeDomainData(buf);
        if(AC.state==='running')meterTicks++;
        let pk=0;for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]);if(v>pk)pk=v}
        if(pk>recPeak)recPeak=pk;
        const pct=Math.min(100,Math.round(pk*300));
        $('recMeterFill').style.width=pct+'%';$('recMeter').setAttribute('aria-valuenow',pct);
        if(meterOn)meterRaf=requestAnimationFrame(tick);
      }catch(e){meterOn=false}
    };
    tick();
  }catch(e){meterOn=false}
}
function stopMeter(){
  meterOn=false;cancelAnimationFrame(meterRaf);
  try{if(meterSrc)meterSrc.disconnect()}catch(e){}
  meterSrc=null;$('recMeterFill').style.width='0%';
}
async function startRec(){
  recStream=await navigator.mediaDevices.getUserMedia({audio:true});
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(m=>window.MediaRecorder&&MediaRecorder.isTypeSupported(m));
  rec=new MediaRecorder(recStream,mime?{mimeType:mime}:undefined);
  recChunks=[];
  rec.ondataavailable=e=>{if(e.data&&e.data.size)recChunks.push(e.data)};
  rec.start();
  startMeter();
}
function stopRec(){
  return new Promise(res=>{
    rec.onstop=()=>{stopMeter();recStream.getTracks().forEach(t=>t.stop());res(new Blob(recChunks,{type:rec.mimeType||'audio/webm'}))};
    rec.stop();
  });
}
function renderRec(status){
  const item=RS.list[RS.i];
  $('recWorld').textContent=pre?t('preRecWorld'):t('recWorld',{w:LEVELS[S.level].name});
  $('recText').textContent=item;
  $('recCount').textContent=t('recOf',{i:RS.i+1,n:RS.list.length})+(clipURL[ck(item)]?t('recDone'):'');
  $('recBtn').textContent=RS.on?t('recStop'):t('recStart');
  $('recMeter').hidden=!RS.on;
  $('recPlay').hidden=!clipURL[ck(item)];
  $('recStatus').textContent=status||(RS.on?t('recRecording',{t:item}):'');
}
function openRecorder(){
  RS.list=pre?pre.recItems():recItems(S.level);
  const miss=RS.list.findIndex(x=>!clipURL[ck(x)]);
  RS.i=miss<0?0:miss;RS.on=false;
  $('recorder').hidden=false;renderRec();$('recBtn').focus();
}
function closeRec(){
  if(RS.on){RS.on=false;try{stopRec()}catch(e){}}
  $('recorder').hidden=true;
}
async function toggleRec(){
  const item=RS.list[RS.i];
  if(!RS.on){
    try{await startRec();RS.on=true;renderRec()}
    catch(e){renderRec(t('recMic'))}
  }else{
    let blob=null;
    try{blob=await stopRec()}catch(e){}
    RS.on=false;
    if(blob&&blob.size&&meterTicks>=2&&recPeak<SILENT_PEAK)renderRec(t('recSilent'));
    else if(blob&&blob.size){
      setClip(ck(item),blob);
      try{await idbSet(ck(item),blob)}catch(e){}
      updateRecInfo();renderRec(t('recSaved'));
    }else renderRec(t('recNone'));
  }
}
$('recOpen').onclick=openRecorder;
$('recBtn').onclick=toggleRec;
$('recPlay').onclick=()=>playClip(ck(RS.list[RS.i]));
$('recNext').onclick=()=>{if(RS.on)return;RS.i=(RS.i+1)%RS.list.length;renderRec()};
$('recPrev').onclick=()=>{if(RS.on)return;RS.i=(RS.i-1+RS.list.length)%RS.list.length;renderRec()};
$('recClose').onclick=closeRec;
let clearArmed=false;
$('recClear').onclick=async e=>{
  const b=e.target;
  if(!clearArmed){clearArmed=true;b.textContent=t('sure');setTimeout(()=>{clearArmed=false;b.textContent=t('recClear')},3500);return}
  clearArmed=false;b.textContent=t('recClear');
  try{await idbClear()}catch(err){}
  Object.keys(clipURL).forEach(k=>{URL.revokeObjectURL(clipURL[k]);delete clipURL[k]});
  updateRecInfo();
};
$('voiceSel').onchange=e=>{S.voiceURIs[S.lang]=e.target.value;save();pickVoice();say(t('sample'))};
$('sessionSel').value=String(S.sessionLen);
$('hint').onclick=()=>sayHint(true);
$('hint').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sayHint(true)}};
$('mascot').onclick=()=>sayHint(true);
$('lumiBig').onclick=()=>{if(curAudio)curAudio.pause();talkStop()};
$('sessionSel').onchange=e=>{S.sessionLen=parseInt(e.target.value,10);save();renderSession()};
$('endMore').onclick=()=>{$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();pre?pre.begin():next()};
$('endLevelUpBtn').onclick=()=>{if(pre)pre.unlockNext();else{S.level++;save();renderLevels()}$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();pre?pre.begin():next()};
$('endStop').onclick=()=>{$('end').hidden=true;restState()};
renderSession();

function applyLang(){
  document.documentElement.lang=S.lang;
  document.querySelectorAll('[data-i]').forEach(el=>{el.textContent=t(el.getAttribute('data-i'))});
  document.querySelectorAll('[data-ia]').forEach(el=>{
    el.getAttribute('data-ia').split(';').forEach(p=>{const kv=p.split(':');el.setAttribute(kv[0],t(kv[1]))});
  });
  $('langBtn').textContent=S.lang==='ca'?'CA':'ES';
  updateHello();renderLevels();renderPath();renderMode();renderHard();renderSession();renderAlbum();renderWorlds();updateRecInfo();
  if(hasTTS)pickVoice();
  if(phase==='read'||phase==='judge')$('hint').textContent=hintFor(phase);
}
function setLang(l){
  if(RS.on)return;
  S.lang=l;LEVELS=LV[l]||LV_ES;
  if(S.level>=LEVELS.length)S.level=0;
  sDone=sOk=sStk=0;pendingEnd=false;resting=false;newWorld();
  save();applyLang();renderSession();pre?pre.refresh():next();
}
$('langBtn').onclick=()=>setLang(S.lang==='es'?'ca':'es');

applyTheme();applyCase();applySound();applyLang();loadClips();updateProfileChip();
loadManifest().then(()=>{introHint();setTimeout(warmAudio,3000)});
renderGoal();next();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});

// ---------- letter sounds (pre-reader profile; spec in docs/superpowers/specs) ----------
if(PROFILE.kind==='pre'){
  document.documentElement.classList.add('pre');
  cur=null;phase='wait';
  try{
    const imp=window.__leemosImport||(p=>import(p));
    const [mod,dEs,dCa]=await Promise.all([imp('./sounds.js'),loadJSON('src/data/sounds.es.json'),loadJSON('src/data/sounds.ca.json')]);
    const sess={reset(){sDone=sOk=sStk=0;renderSession();renderGoal()},inc(ok){sDone++;if(ok)sOk++},get done(){return sDone},addSticker(){sStk++}};
    pre=mod.createSounds({doc:document,$,S,save,t,say,sfx,poke,burst,sparkle:sparkleBurst,rnd,fmt,nm,later:(f,ms)=>setTimeout(f,ms),
      data:{es:dEs,ca:dCa},earnSticker,sess,renderSession,renderGoal,renderAlbum,renderHard,end:showEnd,
      hasAudio:x=>!!(clipURL[ck(x)]||genFile(x)),
      reward:(e,alive)=>{pendingEnd=true;setTimeout(()=>{if(!alive||alive())showReward(e);else pendingEnd=false},500)}});
    $('pre').hidden=false;
    $('profileBtn').hidden=true; // a child must not reach another profile; parents switch from their panel
    document.querySelector('[data-i="pIntro"]').setAttribute('data-i','prePIntro');
    applyLang();
    pre.refresh();
  }catch(e){
    // sounds.js or its data did not load (e.g. offline before the service worker cached them): show the normal screen, not a blank stage.
    pre=null;
    document.documentElement.classList.remove('pre');
    $('pre').hidden=true;
    phase='read';next();
  }
}
