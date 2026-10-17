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
  if(m[2].length>1&&/[iu]$/.test(m[2])&&!/^[iu][aeiou]$/.test(m[2]))return 4; // glide ending (neu, bou, rei)
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
