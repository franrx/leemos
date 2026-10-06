// Leemos: syllable reading practice. ES module, no build step. See CLAUDE.md.
// ---------- data (edit the JSON files in src/data/, not this file) ----------
const loadJSON=u=>fetch(u).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json()});
const [LV_ES,LV_CA,WORLDS,STICKERS,T_ES,T_CA]=await Promise.all([
  loadJSON('src/data/levels.es.json'),loadJSON('src/data/levels.ca.json'),loadJSON('src/data/worlds.json'),
  loadJSON('src/data/stickers.json'),loadJSON('src/data/i18n.es.json'),loadJSON('src/data/i18n.ca.json')
]);
const LV={es:LV_ES,ca:LV_CA};
let LEVELS=LV_ES;
const T={es:T_ES,ca:T_CA};

const wn=w=>S.lang==='ca'?w.nameCa:w.name;
const rnd=a=>a[Math.floor(Math.random()*a.length)];
const nm=()=>(S.name||'').trim()||'campeona';
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
const KEY='leemos-v1';
const load=()=>{try{return JSON.parse(localStorage.getItem(KEY))||{}}catch(e){return {}}};
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}};
const S=Object.assign({stats:{},level:0,mode:'syl',upper:false,rate:.75,theme:'',name:'Elsa',total:0,progress:0,stickers:0,sound:true,voiceURI:'',voiceURIs:{es:'',ca:''},world:'auto',lang:((navigator.language||'').toLowerCase().indexOf('ca')===0?'ca':'es'),sessionLen:10},load());
if(!S.voiceURIs)S.voiceURIs={es:'',ca:''};
LEVELS=LV[S.lang]||LV_ES;
let cur=null,last=null,phase='read',resetArmed=false;
let sDone=0,sOk=0,sStk=0,pendingEnd=false,resting=false;
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
    curAudio=new Audio('audio/'+S.lang+'/'+f);
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
    const stamp=genManifest.generated||'';if(!stamp||S.warmed===stamp)return;
    const jobs=[];
    Object.keys(genManifest.clips||{}).forEach(l=>Object.values(genManifest.clips[l]).forEach(f=>jobs.push('audio/'+l+'/'+f)));
    let i=0;
    const worker=async()=>{while(i<jobs.length){const u=jobs[i++];try{await fetch(u)}catch(e){return}}};
    await Promise.all([worker(),worker(),worker()]);
    S.warmed=stamp;save();
  }catch(e){}
}

// ---------- items ----------
const itemsFor=(lv,mode)=>{
  const L=LEVELS[lv];
  return mode==='syl'
    ? L.syl.map(s=>({key:(S.lang==='ca'?'ca:':'')+'s:'+s,parts:splitSyl(s),text:s,emoji:null}))
    : L.words.map(o=>({key:(S.lang==='ca'?'ca:':'')+'w:'+o.w,parts:o.w.split('-'),text:o.w.replace(/-/g,''),emoji:o.e,tags:(o.g||'').split(' ')}));
};
function pick(){
  let pool=itemsFor(S.level,S.mode).filter(i=>!last||i.key!==last||itemsFor(S.level,S.mode).length<2);
  if(S.mode==='word'){
    const wid=WORLDS[worldNow()].id;
    const themed=pool.filter(i=>i.tags&&i.tags.indexOf(wid)>=0);
    if(themed.length&&Math.random()<(themed.length>=3?.8:.4))pool=themed;
  }
  const wts=pool.map(i=>{const s=S.stats[i.key]||{ok:0,fail:0};return Math.max(.25,1+s.fail*2.5-s.ok*.35+(s.ok+s.fail===0?1.5:0))});
  let r=Math.random()*wts.reduce((a,b)=>a+b,0);
  for(let i=0;i<pool.length;i++){r-=wts[i];if(r<=0)return pool[i]}
  return pool[0];
}

// ---------- render ----------
function renderLevels(){
  const box=$('levels');box.innerHTML='';
  LEVELS.forEach((L,i)=>{
    const all=[...itemsFor(i,'syl'),...itemsFor(i,'word')];
    const pct=Math.round(100*all.filter(x=>mastered(x.key)).length/all.length);
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
  list.forEach(([k])=>{const c=document.createElement('span');c.className='chip';c.textContent=k.replace(/^ca:/,'').slice(2);box.appendChild(c)});
}
const hintFor=p=>p==='read'
  ? t(S.mode==='syl'?'hintSyl':'hintWord',{n:nm()})
  : t('hintJudge');
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
    b.className='tile c'+(i%5)+(S.mode==='syl'?' static':'');
    b.textContent=p;
    b.setAttribute('aria-label',p);
    if(S.mode==='word') b.onclick=()=>say(p);
    t.appendChild(b);
  });
  const pic=$('pic');
  pic.hidden=S.mode!=='word';
  pic.className='pic q';pic.textContent='?';
  setPhase('read');
}
const worldNow=()=>S.world==='auto'?curWorld:Math.min(S.world,WORLDS.length-1);
function newWorld(){if(S.world==='auto')curWorld=(curWorld+1)%WORLDS.length}
function renderWorlds(){
  const g=$('worldGrid');g.innerHTML='';
  const mk=(val,icon,label,w)=>{
    const b=document.createElement('button');b.className='wbtn';b.setAttribute('aria-pressed',S.world===val);
    if(w)b.style.background='linear-gradient(165deg,color-mix(in srgb,'+w.a+' 55%,var(--panel)),color-mix(in srgb,'+w.b+' 40%,var(--panel)))';
    b.innerHTML='<span>'+icon+'</span>'+label;
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
  sDone++;if(ok)sOk++;
  const finished=sDone>=S.sessionLen;
  let reward=null;
  if(finished&&S.stickers<STICKERS.length){S.stickers++;reward=STICKERS[S.stickers-1];sStk++}
  save();
  renderSession();renderGoal();
  const msg=fmt(rnd(t(ok?'oks':'nos')));
  $('hint').textContent=msg;
  if(reward){
    setTimeout(()=>showReward(reward),500);
    pendingEnd=true;
  }else if(S.sound&&(!ok||Math.random()<.6)){
    setTimeout(()=>say(msg),200);
  }
  renderLevels();renderHard();renderAlbum();
  if(finished){if(!reward)setTimeout(showEnd,ok?1100:900)}
  else setTimeout(next,ok?1100:900);
}

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
  STICKERS.forEach((e,i)=>{
    const d=document.createElement('div');
    d.className='sticker'+(i<S.stickers?'':' locked');
    d.textContent=e;
    d.setAttribute('aria-label',i<S.stickers?t('albumGot',{e:e}):t('albumLocked'));
    g.appendChild(d);
  });
  $('albumInfo').textContent=t('albumInfo',{s:S.stickers,t:STICKERS.length,x:S.total});
}
function showReward(e){
  $('rewardEmoji').textContent=e;
  $('rewardTitle').textContent=t('rewardTitle',{n:nm()});
  $('reward').hidden=false;
  confetti();sfx.win();flash();poke('dance',1600);
  sparkleBurst($('rewardEmoji'),18);
  if(S.sound)say(t('rewardTitle',{n:nm()}));
  $('rewardOk').focus();
}
function closeOverlays(){
  const wasReward=!$('reward').hidden, wasEnd=!$('end').hidden;
  $('reward').hidden=true;$('album').hidden=true;$('end').hidden=true;$('worlds').hidden=true;closeRec();
  if(wasReward&&pendingEnd){pendingEnd=false;setTimeout(showEnd,250)}
  else if(wasEnd)restState();
}
function renderSession(){
  const n=S.sessionLen,d=Math.min(sDone,n);
  $('sfill').style.width=Math.round(100*d/n)+'%';
  $('slabel').textContent=t('recOf',{i:d,n:n});
  const b=$('sbar');b.setAttribute('aria-valuemax',n);b.setAttribute('aria-valuenow',d);
}
function showEnd(){
  const n=S.sessionLen;
  $('endTitle').textContent=t('endTitle',{n:nm()});
  $('endInfo').textContent=t('endInfo',{o:sOk,n:n})+(sStk?(sStk===1?t('endOne'):t('endMany',{k:sStk})):'');
  $('end').hidden=false;
  confetti();sfx.win();flash();poke('dance',1600);
  if(S.sound)say(t('endTitle',{n:nm()}));
  $('endMore').focus();
}
function restState(){
  resting=true;cur=null;phase='wait';
  $('tiles').innerHTML='';$('pic').hidden=true;
  $('joinBtn').hidden=true;
  ['hearBtn','okBtn','noBtn'].forEach(id=>$(id).hidden=true);
  $('hint').textContent=t('rest',{n:nm()});
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
function setMode(m){
  S.mode=m;save();
  $('mSyl').setAttribute('aria-pressed',m==='syl');
  $('mWord').setAttribute('aria-pressed',m==='word');
  next();
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
  Object.keys(S.stats).forEach(k=>{if((S.lang==='ca')===(k.indexOf('ca:')===0))delete S.stats[k]});save();resetArmed=false;e.target.textContent=t('resetBtn');renderLevels();renderHard();next();
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

$('mSyl').setAttribute('aria-pressed',S.mode==='syl');
$('mWord').setAttribute('aria-pressed',S.mode==='word');
$('albumBtn').onclick=()=>{renderAlbum();$('album').hidden=false;$('albumClose').focus()};
$('albumClose').onclick=closeOverlays;
$('worldBtn').onclick=()=>{renderWorlds();$('worlds').hidden=false;$('worldsClose').focus()};
$('worldsClose').onclick=closeOverlays;
$('rewardOk').onclick=closeOverlays;
['album','reward','worlds'].forEach(id=>$(id).addEventListener('click',e=>{if(e.target.id===id)closeOverlays()}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOverlays()});
$('soundBtn').onclick=()=>{S.sound=!S.sound;save();applySound();if(S.sound)sfx.ok()};
$('nm').value=S.name;
$('nm').oninput=e=>{
  S.name=e.target.value;save();updateHello();
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
async function startRec(){
  recStream=await navigator.mediaDevices.getUserMedia({audio:true});
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(m=>window.MediaRecorder&&MediaRecorder.isTypeSupported(m));
  rec=new MediaRecorder(recStream,mime?{mimeType:mime}:undefined);
  recChunks=[];
  rec.ondataavailable=e=>{if(e.data&&e.data.size)recChunks.push(e.data)};
  rec.start();
}
function stopRec(){
  return new Promise(res=>{
    rec.onstop=()=>{recStream.getTracks().forEach(t=>t.stop());res(new Blob(recChunks,{type:rec.mimeType||'audio/webm'}))};
    rec.stop();
  });
}
function renderRec(status){
  const item=RS.list[RS.i];
  $('recWorld').textContent=t('recWorld',{w:LEVELS[S.level].name});
  $('recText').textContent=item;
  $('recCount').textContent=t('recOf',{i:RS.i+1,n:RS.list.length})+(clipURL[ck(item)]?t('recDone'):'');
  $('recBtn').textContent=RS.on?t('recStop'):t('recStart');
  $('recPlay').hidden=!clipURL[ck(item)];
  $('recStatus').textContent=status||(RS.on?t('recRecording',{t:item}):'');
}
function openRecorder(){
  RS.list=recItems(S.level);
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
    if(blob&&blob.size){
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
$('sessionSel').onchange=e=>{S.sessionLen=parseInt(e.target.value,10);save();renderSession()};
$('endMore').onclick=()=>{$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();next()};
$('endStop').onclick=()=>{$('end').hidden=true;restState()};
renderSession();

function applyLang(){
  document.documentElement.lang=S.lang;
  document.querySelectorAll('[data-i]').forEach(el=>{el.textContent=t(el.getAttribute('data-i'))});
  document.querySelectorAll('[data-ia]').forEach(el=>{
    el.getAttribute('data-ia').split(';').forEach(p=>{const kv=p.split(':');el.setAttribute(kv[0],t(kv[1]))});
  });
  $('langBtn').textContent=S.lang==='ca'?'CA':'ES';
  updateHello();renderLevels();renderHard();renderSession();renderAlbum();renderWorlds();updateRecInfo();
  if(hasTTS)pickVoice();
  if(phase==='read'||phase==='judge')$('hint').textContent=hintFor(phase);
}
function setLang(l){
  if(RS.on)return;
  S.lang=l;LEVELS=LV[l]||LV_ES;
  if(S.level>=LEVELS.length)S.level=0;
  sDone=sOk=sStk=0;pendingEnd=false;resting=false;newWorld();
  save();applyLang();renderSession();next();
}
$('langBtn').onclick=()=>setLang(S.lang==='es'?'ca':'es');

applyTheme();applyCase();applySound();applyLang();loadClips();
loadManifest().then(()=>setTimeout(warmAudio,3000));
renderGoal();next();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
