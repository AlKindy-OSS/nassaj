// Strong RTL letters: Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms.
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻾]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** One base direction per message, from its first strong character (not per block). */
export function detectDirection(text: string): 'rtl' | 'ltr' {
  for (const char of text) {
    if (RTL_CHAR.test(char)) return 'rtl';
    if (LTR_CHAR.test(char)) return 'ltr';
  }
  return 'rtl';
}
