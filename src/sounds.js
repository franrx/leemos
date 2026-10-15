// Leemos letter sounds (pre-reader profile). ES module with no globals: everything the app owns
// comes in through ctx (see createSounds). The pure helpers below are unit-tested in tests/sounds.mjs.

export const NEW_PER_SESSION=2;
// Letters children mix up; only offered together once both are mastered.
export const CONFUSABLE=[['m','n'],['b','d'],['p','b']];

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
