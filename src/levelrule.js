// Placement rule for the book-aligned content (spec: docs/superpowers/specs/2026-10-17-book-content-design.md).
// Pure module, no globals: tests and scripts import it directly; the app can load it later through the dynamic-import seam.
const norm=s=>s.toLowerCase().replace(/ñ/g,'ny').replace(/ç/g,'ss').normalize('NFD').replace(/[̀-ͯ]/g,'');

// Minimum level of ONE syllable:
// 1 direct m s l n or a bare vowel; 2 direct p t b d c(k); 3 direct f v r g j; 4 closed, glide-ending or onset cluster; 5 special spelling.
export function sylLevel(raw){
  const s=norm(raw);
  if(/tx|ny|ll|rr|qu|ch|h|x|z|ss|gu[ei]|[cg][ei]/.test(s))return 5;
  if(/^(pl|bl|cl|fl|gl|pr|br|tr|gr|dr|fr|cr)/.test(s))return 4;
  const m=s.match(/^([^aeiou]*)([aeiou]+)(.*)$/);
  if(!m)return 5;
  if(m[3])return 4; // closed syllable (al, et, am...)
  if(m[2].length>1&&/[iu]$/.test(m[2])&&!/^[iu][aeo]$/.test(m[2]))return 4; // glide ending (neu, bou, rei)
  const c=m[1][0]||'';
  if(!c)return 1;
  if('msln'.includes(c))return 1;
  if('ptbdck'.includes(c))return 2;
  if('fvrgj'.includes(c))return 3;
  return 5;
}

// Minimum level of a hyphenated word ("ca-sa"): its hardest syllable, and at least 3 for words of 3+ syllables.
export function minLevel(hyphenated){
  const parts=hyphenated.split('-');
  const l=Math.max(...parts.map(sylLevel));
  return parts.length>=3?Math.max(l,3):l;
}

// Book letter of a word: its first grapheme, accents ignored (ch ll ny qu tx rr gu count as one).
export function letterOf(hyphenated){
  const s=norm(hyphenated.replace(/-/g,''));
  const m=s.match(/^(ch|ll|ny|qu|tx|rr|gu)/);
  return m?m[1]:s[0];
}

// ---------- Camino de Elsa: the letter path (spec: docs/superpowers/specs/2026-10-17-elsas-path-design.md) ----------
// Step n (1-based) means the first n entries are open; the last step opens every other letter.
export const STEPS=['m','p','l','n','t','s','f','b','d','r','c','*'];
// Consonant units of a word or syllable: vowels are skipped and ch ll ny qu tx rr gu ss count as one unit.
export function unitsOf(hyphenated){
  return norm(hyphenated.replace(/-/g,'')).match(/ch|ll|ny|qu|tx|rr|gu|ss|[^aeiou]/g)||[];
}
// The step that opens one unit: the book letters 1..11 (rr is an R); every other unit, known or not, opens with the last step.
export function stepOfUnit(u){
  if(u==='rr')return STEPS.indexOf('r')+1;
  const i=STEPS.indexOf(u);
  return i>=0&&i<STEPS.length-1?i+1:STEPS.length;
}
// The step an item needs: its hardest unit; 0 when it has no consonant (a bare vowel).
export function stepOf(hyphenated){
  return unitsOf(hyphenated).reduce((m,u)=>Math.max(m,stepOfUnit(u)),0);
}
