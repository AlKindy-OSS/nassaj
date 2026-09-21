/**
 * Unit tests for workflowStatusStore — referential stability (B-103).
 *
 * يُثبت ضمانَي الأداء الحرجَين في setActiveWorkflows:
 *   1. نفس اللقطة ⇒ نفس المرجع (لا re-render — useSyncExternalStore يعتمد Object.is)
 *   2. لقطة مختلفة ⇒ مرجع جديد (التغيير يصل للمُستمعين)
 *
 * أشكال البيانات مأخوذة من عقد الـendpoint الفعلي
 * (GET /api/providers/workflows/active) لا fixtures ملفّقة.
 *
 * Run: npm run test:client -- src/stores/workflowStatusStore.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import {
  setActiveWorkflows,
  __resetWorkflowStatusStore,
  useSessionWorkflows,
  useProjectWorkflowRollup,
  useWorkflowsEnvelope,
} from './workflowStatusStore';
import type { WorkflowEnvelope } from './workflowStatusStore';
import type { ActiveWorkflowsEnvelope, ActiveWorkflow } from './workflowStatus';


// ── الخمول: صفوف تُحجب عند الإدخال لا عند القراءة ──────────────────────────
//
// المقاس على القرص (2026-07-29، 35 مجلد ورشة حقيقياً): ستّ ورش عالقة في
// `unknown` بلا أي مخرج — أعمارها 0.8 إلى 20.2 يوماً وكلّها صامتة. الخادم صار
// يُعلّمها `dormant`، وهذا الملف يثبّت أن الحجب يقع **عند الإدخال**: الترشيح في
// المُحدِّدات كان سيبني مصفوفة جديدة في كل قراءة snapshot، و`useSyncExternalStore`
// يعيد التصيير بلا نهاية حين يتغيّر المرجع في كل نداء.
describe('dormant workflows', () => {
  const dormantRow = (sessionId: string, wfId: string): ActiveWorkflow => ({
    ...makeWorkflow(sessionId, wfId, 'unknown'),
    dormant: true,
  });

  it('لا تدخل قائمة الجلسة إطلاقاً', () => {
    act(() => {
      setActiveWorkflows(makeEnvelope([
        makeWorkflow('s1', 'wf_live', 'running'),
        dormantRow('s1', 'wf_10000000-demo'),
      ]));
    });

    const { result } = renderHook(() => useSessionWorkflows('s1'));
    expect(result.current.map((w) => w.wfId)).toEqual(['wf_live']);
  });

  it('جلسة كل ورشها خاملة ⇒ قائمة فارغة (الشارة والشريط يصمتان معاً)', () => {
    act(() => {
      setActiveWorkflows(makeEnvelope([
        dormantRow('s2', 'wf_20000000-demo'),
        dormantRow('s2', 'wf_30000000-demo'),
      ]));
    });

    const { result } = renderHook(() => useSessionWorkflows('s2'));
    expect(result.current).toHaveLength(0);
  });

  it('لا تُلوّن تجميعة المشروع — «هادئ» لا «مجهول»', () => {
    act(() => {
      setActiveWorkflows(makeEnvelope([dormantRow('s3', 'wf_40000000-demo')]));
    });

    const { result } = renderHook(() => useProjectWorkflowRollup(['s3']));
    expect(result.current).toBeNull();
  });

  it('العدّاد ينجو من الحجب — الإخفاء ليس صامتاً', () => {
    // الحارس الذي طلبه الناقد: «تُسجَّل لا تُحذف» بلا أثر مرئي = نصّ ADR بلا أثر.
    act(() => {
      setActiveWorkflows({
        ...makeEnvelope([dormantRow('s4', 'wf_50000000-demo')]),
        dormant: 1,
      });
    });

    const { result } = renderHook(() => useWorkflowsEnvelope());
    expect(result.current.dormant).toBe(1);
  });

  it('خادم أقدم بلا الحقل ⇒ لا حجب ولا عدّ (توافق خلفي)', () => {
    act(() => {
      setActiveWorkflows(makeEnvelope([makeWorkflow('s5', 'wf_old', 'unknown')]));
    });

    const { result } = renderHook(() => useSessionWorkflows('s5'));
    expect(result.current).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers that build representative endpoint shapes
// ---------------------------------------------------------------------------

function makeWorkflow(
  sessionId: string,
  wfId: string,
  status: ActiveWorkflow['status'] = 'running',
  agentsDone = 0,
  agentsTotal = 0,
  updatedAt: string | null = '2026-07-04T10:00:00.000Z',
): ActiveWorkflow {
  return {
    sessionId, wfId, status, agentsDone, agentsTotal, updatedAt,
    agents: [], agentsTruncated: false, dormant: false,
  };
}

function makeEnvelope(
  workflows: ActiveWorkflow[],
  eligible: number = workflows.length,
  scanned: number = workflows.length,
  capped = false,
): ActiveWorkflowsEnvelope {
  return { workflows, eligible, scanned, capped, dormant: 0 };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetWorkflowStatusStore();
});

afterEach(() => {
  cleanup();
  __resetWorkflowStatusStore();
});

// ---------------------------------------------------------------------------
// Referential stability: same snapshot ⇒ same reference
// ---------------------------------------------------------------------------

describe('setActiveWorkflows — referential stability', () => {
  it('identical envelope does not change the per-session array reference', () => {
    const wf = makeWorkflow('s1', 'wf_abc', 'running', 3, 5);
    const env = makeEnvelope([wf]);

    const { result } = renderHook(() => useSessionWorkflows('s1'));

    act(() => {
      setActiveWorkflows(env);
    });
    const ref1 = result.current;
    expect(ref1).toHaveLength(1);

    // Same envelope again — snapshotSig unchanged => emitChange NOT called.
    act(() => {
      setActiveWorkflows(env);
    });

    expect(result.current).toBe(ref1); // strict identity: same object
  });

  it('identical envelope with multiple sessions preserves all per-session refs', () => {
    const wf1 = makeWorkflow('s1', 'wf_1', 'running', 0, 0);
    const wf2 = makeWorkflow('s2', 'wf_2', 'orphan', 5, 10);
    const env = makeEnvelope([wf1, wf2], 2, 2);

    const { result: r1 } = renderHook(() => useSessionWorkflows('s1'));
    const { result: r2 } = renderHook(() => useSessionWorkflows('s2'));

    act(() => {
      setActiveWorkflows(env);
    });
    const ref1 = r1.current;
    const ref2 = r2.current;

    act(() => {
      setActiveWorkflows(env);
    });

    expect(r1.current).toBe(ref1);
    expect(r2.current).toBe(ref2);
  });

  it('orphan workflow snapshot is stable when repeated unchanged', () => {
    const wf = makeWorkflow('s1', 'wf_incident', 'orphan', 15, 16, '2026-06-27T15:00:00.000Z');
    const env = makeEnvelope([wf], 1, 1, false);

    const { result } = renderHook(() => useSessionWorkflows('s1'));

    act(() => {
      setActiveWorkflows(env);
    });
    const ref1 = result.current;

    act(() => {
      setActiveWorkflows(env);
    });
    expect(result.current).toBe(ref1);
  });
});

// ---------------------------------------------------------------------------
// Referential stability: different snapshot ⇒ new reference
// ---------------------------------------------------------------------------

describe('setActiveWorkflows — new reference on change', () => {
  it('changed status produces a new array reference for that session', () => {
    const env1 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running', 3, 5)]);
    const env2 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'orphan', 3, 5)]);

    const { result } = renderHook(() => useSessionWorkflows('s1'));

    act(() => {
      setActiveWorkflows(env1);
    });
    const ref1 = result.current;

    act(() => {
      setActiveWorkflows(env2);
    });
    // Different status in env2 ⇒ new snapshot sig ⇒ emitChange ⇒ new reference.
    expect(result.current).not.toBe(ref1);
    expect(result.current[0].status).toBe('orphan');
  });

  it('changed progress counters produce a new reference', () => {
    const env1 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running', 3, 5)]);
    const env2 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running', 4, 5)]);

    const { result } = renderHook(() => useSessionWorkflows('s1'));

    act(() => { setActiveWorkflows(env1); });
    const ref1 = result.current;

    act(() => { setActiveWorkflows(env2); });
    expect(result.current).not.toBe(ref1);
    expect(result.current[0].agentsDone).toBe(4);
  });

  it('empty envelope after non-empty produces a new (empty) reference', () => {
    const envFull = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running')]);
    const envEmpty = makeEnvelope([], 0, 1, false);

    const { result } = renderHook(() => useSessionWorkflows('s1'));

    act(() => { setActiveWorkflows(envFull); });
    const ref1 = result.current;
    expect(ref1).toHaveLength(1);

    act(() => { setActiveWorkflows(envEmpty); });
    // Session 's1' is no longer in the map — returns EMPTY_LIST (a stable frozen ref).
    expect(result.current).toHaveLength(0);
    expect(result.current).not.toBe(ref1);
  });
});

// ---------------------------------------------------------------------------
// Envelope counters: same content stability
// ---------------------------------------------------------------------------

describe('useWorkflowsEnvelope — counter stability', () => {
  it('identical envelope counters do not replace the envelope object reference', () => {
    const env1 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running')], 1, 1, false);
    const env2 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'orphan')], 1, 1, false);

    const { result } = renderHook(() => useWorkflowsEnvelope());

    act(() => { setActiveWorkflows(env1); });
    const envRef1 = result.current;
    const expected: WorkflowEnvelope = { eligible: 1, scanned: 1, capped: false, dormant: 0 };
    expect(envRef1).toEqual(expected);

    // env2 changes workflows but keeps same counters => envelope ref stable.
    act(() => { setActiveWorkflows(env2); });
    expect(result.current).toBe(envRef1); // same envelope object
  });

  it('changed counters produce a new envelope object', () => {
    const env1 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running')], 1, 1, false);
    const env2 = makeEnvelope([makeWorkflow('s1', 'wf_abc', 'running')], 2, 2, true);

    const { result } = renderHook(() => useWorkflowsEnvelope());

    act(() => { setActiveWorkflows(env1); });
    const envRef1 = result.current;

    act(() => { setActiveWorkflows(env2); });
    expect(result.current).not.toBe(envRef1);
    expect(result.current).toEqual({ eligible: 2, scanned: 2, capped: true, dormant: 0 });
  });
});

// ---------------------------------------------------------------------------
// Session isolation: changes to one session do not change other sessions' refs
// ---------------------------------------------------------------------------

describe('setActiveWorkflows — per-session isolation', () => {
  it('updating s2 does not change s1 reference', () => {
    const wf1 = makeWorkflow('s1', 'wf_1', 'running', 0, 5);
    const wf2a = makeWorkflow('s2', 'wf_2', 'running', 1, 10);
    const wf2b = makeWorkflow('s2', 'wf_2', 'running', 2, 10); // progress changed

    const { result: r1 } = renderHook(() => useSessionWorkflows('s1'));
    const { result: r2 } = renderHook(() => useSessionWorkflows('s2'));

    act(() => { setActiveWorkflows(makeEnvelope([wf1, wf2a])); });
    const ref1 = r1.current;
    const ref2a = r2.current;

    act(() => { setActiveWorkflows(makeEnvelope([wf1, wf2b])); });

    // s1 unchanged — same reference.
    expect(r1.current).toBe(ref1);
    // s2 changed — new reference.
    expect(r2.current).not.toBe(ref2a);
  });
});
