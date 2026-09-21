import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeListContinuation } from './list-continuation';

const atEnd = (text: string) => computeListContinuation(text, text.length, text.length);

describe('computeListContinuation', () => {
  it('لا يتدخل في سطر بلا علامة قائمة', () => {
    assert.equal(atEnd('نص عادي'), null);
  });

  const continuationCases: Array<[string, string, string]> = [
    ['يحافظ على الشرطة النقطية', '- عنصر', '\n- '],
    ['يحافظ على النجمة النقطية', '* عنصر', '\n* '],
    ['يزيد الرقم مع النقطة', '1. عنصر', '\n2. '],
    ['يحافظ على لاحقة القوس', '1) عنصر', '\n2) '],
    ['يمدّد الرقم اللاتيني إلى خانتين', '9. عنصر', '\n10. '],
    ['يحافظ على الأرقام العربية الهندية', '٣. عنصر', '\n٤. '],
    ['يمدّد الرقم العربي الهندي إلى خانتين', '٩. عنصر', '\n١٠. '],
    ['يحافظ على المسافة البادئة', '  - عنصر', '\n  - '],
  ];

  for (const [name, text, insertText] of continuationCases) {
    it(name, () => {
      assert.deepEqual(atEnd(text), { kind: 'continue', insertText });
    });
  }

  it('يخرج من علامة فارغة ويحذف السطر كله', () => {
    assert.deepEqual(atEnd('- '), { kind: 'exit', deleteFrom: 0, deleteTo: 2 });
  });

  it('لا يطابق شرطة بلا فراغ بعدها', () => {
    assert.equal(atEnd('-بلا_مسافة'), null);
  });

  it('لا يتدخل حين يكون التحديد غير صفري', () => {
    assert.equal(computeListContinuation('- عنصر', 2, 4), null);
  });

  it('يطابق السطر الكامل حين يكون المؤشر في وسط نص العنصر', () => {
    const text = '- عنصر كامل';
    assert.deepEqual(computeListContinuation(text, 4, 4), {
      kind: 'continue',
      insertText: '\n- ',
    });
  });

  it('يستخرج السطر الحالي الأخير فقط من نص متعدد الأسطر', () => {
    const text = 'السطر الأول\n* عنصر';
    assert.deepEqual(atEnd(text), { kind: 'continue', insertText: '\n* ' });
  });

  it('يرى المحتوى الواقع بعد المؤشر مباشرةً بعد العلامة', () => {
    assert.deepEqual(computeListContinuation('- عنصر', 2, 2), {
      kind: 'continue',
      insertText: '\n- ',
    });
  });
});
