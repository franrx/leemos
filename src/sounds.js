// Leemos letter sounds (pre-reader profile). ES module with no globals: everything the app owns
// comes in through ctx (see createSounds). The pure helpers below are unit-tested in tests/sounds.mjs.

export const NEW_PER_SESSION=2;
// Letters children mix up; only offered together once both are mastered.
export const CONFUSABLE=[['m','n'],['b','d'],['p','b'],['s','z']];

export const sKey=(lang,l)=>(lang==='ca'?'ca:':'')+'snd:'+l;
export const phOf=x=>x.ph||x.l;
export const isMastered=s=>!!s&&s.ok>=2&&s.ok>s.fail;
export const weightFor=s=>{s=s||{ok:0,fail:0};return Math.max(.25,1+s.fail*2.5-s.ok*.35+(s.ok+s.fail===0?1.5:0))};
export const choiceCount=s=>isMastered(s)?3:2;
export const lettersUpTo=(groups,g)=>groups.slice(0,g+1).flatMap(x=>x.letters);
export const shuffle=(a,rand=Math.random)=>a.map(v=>[rand(),v]).sort((p,q)=>p[0]-q[0]).map(p=>p[1]);

export function pickTarget(pool,stats,lang,last,rand=Math.random){
  const cands=pool.length>1?pool.filter(x=>x.l!==last):pool;
  const wts=cands.map(x=>weightFor(stats[sKey(lang,x.l)]));
  let r=rand()*wts.reduce((a,b)=>a+b,0);
  for(let i=0;i<cands.length;i++){r-=wts[i];if(r<=0)return cands[i]}
  return cands[cands.length-1];
}

const confusable=(a,b)=>CONFUSABLE.some(([x,y])=>(x===a&&y===b)||(x===b&&y===a));
// Distractors: never the same sound as the target; seen letters first; confusable pairs only as a last resort.
export function pickDistractors(target,pool,stats,lang,n,rand=Math.random){
  const st=l=>stats[sKey(lang,l)];
  const cands=pool.filter(x=>x.l!==target.l&&phOf(x)!==phOf(target));
  const apart=x=>!confusable(target.l,x.l)||(isMastered(st(target.l))&&isMastered(st(x.l)));
  const good=cands.filter(apart),risky=cands.filter(x=>!apart(x));
  const seen=good.filter(x=>st(x.l)),fresh=good.filter(x=>!st(x.l));
  return [...shuffle(seen,rand),...shuffle(fresh,rand),...shuffle(risky,rand)].slice(0,n);
}

// The next group is offered when at least 3 of every 4 letters of the current one are mastered.
export const canUnlockNext=(groups,g,stats,lang)=>{
  if(g>=groups.length-1)return false;
  const ls=groups[g].letters;
  return ls.filter(x=>isMastered(stats[sKey(lang,x.l)])).length/ls.length>=.75;
};
export function totals(groups,stats,lang){
  const all=groups.flatMap(g=>g.letters);
  return {done:all.filter(x=>isMastered(stats[sKey(lang,x.l)])).length,total:all.length};
}

const face=l=>l.toUpperCase()+l;
const VOWELS=['a','e','i','o','u'];

// The pre-reader flow. ctx supplies state, audio and rewards from app.js (see the "letter sounds" block at the end of app.js).
export function createSounds(ctx){
  const {doc,$,S,save,t,say,sfx}=ctx;
  const lang=()=>S.lang;
  const groups=()=>(ctx.data[lang()]||ctx.data.es).groups;
  const gi=()=>Math.min(S.pre[lang()]||0,groups().length-1);
  const pool=()=>lettersUpTo(groups(),gi());
  const key=l=>sKey(lang(),l);
  const seen=l=>!!S.stats[key(l)];
  const stat=l=>S.stats[key(l)]||(S.stats[key(l)]={ok:0,fail:0});
  const el=(tag,cls,txt)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e};
  const room=()=>$('pre');
  let cur=null,last=null,wrong=false,busy=false,fresh=0,epoch=0;

  function home(){
    cur=null;busy=false;epoch++; // epoch: timers scheduled before this point must not resurrect a screen
    doc.body.classList.add('pre-home');
    const {done,total}=totals(groups(),S.stats,lang());
    const play=el('button','btn primary pre-play',t('prePlay'));play.id='prePlay';
    play.onclick=begin;
    room().replaceChildren(play,el('p','small',t('preProgress',{d:done,n:total})));
    play.focus();
    // Without a clip or a recording the browser voice says a lone consonant's NAME ("eme"), not its sound.
    if(pool().some(x=>!VOWELS.includes(x.l)&&!ctx.hasAudio(x.l))){
      const note=el('p','small pre-notice',t('preNoAudio'));note.id='preNotice';
      room().appendChild(note);
    }
    $('hint').textContent=t('preHello',{n:ctx.nm()});
  }
  function begin(){
    doc.body.classList.remove('pre-home');
    fresh=0;last=null;
    if(ctx.sess.done>=S.sessionLen)ctx.sess.reset(); // a session in progress (restored or synced from another device) continues; a finished one starts again
    next();
  }
  function next(){
    let cands=pool();
    if(fresh>=NEW_PER_SESSION){const known=cands.filter(x=>seen(x.l));if(known.length)cands=known}
    const x=pickTarget(cands,S.stats,lang(),last);
    last=x.l;
    if(seen(x.l))game(x);else{fresh++;intro(x)}
  }
  // Intro card: the picture is shown on purpose here (the goal is sound-letter linking, not reading).
  // The letter only counts as seen once its game step records an answer, so abandoning the card keeps it new.
  function intro(x){
    cur=null;busy=false;
    const letter=el('button','pre-letter');letter.id='preLetter';
    letter.setAttribute('aria-label',x.l);
    letter.append(el('span','up',x.l.toUpperCase()),el('span','lo',x.l));
    letter.onclick=()=>say(x.l);
    const word=el('button','pre-word');word.id='preWord';
    word.append(el('span','pre-pic',x.e),el('span','',x.w));
    word.onclick=()=>say(x.w);
    const go=el('button','btn primary',t('preNext'));go.id='preNext';
    go.onclick=()=>game(x);
    const card=el('div','pre-card');card.append(letter,word,go);
    room().replaceChildren(card);
    go.focus();
    $('hint').textContent=t('preIntroHint');
    say(x.l);
  }
  function game(x){
    cur=x;wrong=false;busy=false;
    const n=choiceCount(S.stats[key(x.l)]);
    const opts=shuffle([x,...pickDistractors(x,pool(),S.stats,lang(),n-1)]);
    const hear=el('button','btn pre-hear','🔊 '+t('preHear'));hear.id='preHear';
    hear.onclick=()=>say(x.l);
    const row=el('div','pre-choices');row.id='preChoices';
    row.dataset.answer=x.l; // test hook; the child cannot read the DOM
    opts.forEach(o=>{
      const b=el('button','pre-choice',face(o.l));
      b.dataset.l=o.l;b.setAttribute('aria-label',o.l);
      b.onclick=()=>choose(o,b,x);
      row.appendChild(b);
    });
    room().replaceChildren(hear,row);
    hear.focus();
    $('hint').textContent=t('preGameHint');
    say(x.l);
  }
  function choose(o,b,x){
    if(busy||cur!==x)return;
    if(o.l===x.l){correct(x,b);return}
    sfx.retry();ctx.poke('tilt',800);
    b.classList.add('gone');b.disabled=true;
    if(!wrong){wrong=true;stat(x.l).fail++;save();ctx.renderHard()}
    $('hint').textContent=ctx.fmt(ctx.rnd(t('preNos')));
    const nextChoice=room().querySelector('.pre-choice:not(:disabled)');
    if(nextChoice)nextChoice.focus(); // the tapped button just became disabled and dropped focus
    say(x.l); // replay the sound so the next try is informed
  }
  function correct(x,b){
    busy=true;
    b.classList.add('right');
    if(!wrong)stat(x.l).ok++;
    S.total++;
    ctx.burst();sfx.ok();ctx.poke('cheer',900);ctx.sparkle($('mascot'),10);
    const pic=el('div','pre-pic big',x.e);pic.id='prePic';
    room().appendChild(pic);
    $('hint').textContent=ctx.fmt(ctx.rnd(t('preOks')));
    ctx.sess.inc(!wrong);
    const finished=ctx.sess.done>=S.sessionLen;
    let reward=null;
    if(finished&&S.stickers<ctx.stickers.length){S.stickers++;reward=ctx.stickers[S.stickers-1];ctx.sess.addSticker()}
    save();
    ctx.renderSession();ctx.renderGoal();ctx.renderAlbum();ctx.renderHard();
    const e=epoch,alive=()=>e===epoch;
    if(reward)ctx.reward(reward,alive);
    else if(finished)ctx.later(()=>{if(alive())ctx.end()},1100);
    else ctx.later(()=>{if(alive())next()},1300);
  }

  // End of session: offer the next group when most of this one is mastered. Returns whether it is offered.
  function showEnd(){
    const up=canUnlockNext(groups(),gi(),S.stats,lang());
    $('endLevelUp').hidden=!up;$('endLevelUpBtn').hidden=!up;
    // Secondary on purpose: a child tapping the big button should start another session, not unlock harder letters.
    $('endLevelUpBtn').classList.remove('primary');
    if(up){$('endLevelUp').textContent=t('preGroupUp');$('endLevelUpBtn').textContent=t('preGroupUpBtn')}
    return up;
  }
  function unlockNext(){S.pre[lang()]=Math.min(gi()+1,groups().length-1);save()}
  function rest(){home();$('hint').textContent=t('preRest',{n:ctx.nm()})}
  // Everything the parent can record: all letter sounds first, then the picture words.
  function recItems(){
    const set=new Set();
    groups().forEach(g=>g.letters.forEach(x=>set.add(x.l)));
    groups().forEach(g=>g.letters.forEach(x=>set.add(x.w)));
    return [...set];
  }

  return {refresh:home,begin,next,showEnd,unlockNext,rest,recItems};
}
