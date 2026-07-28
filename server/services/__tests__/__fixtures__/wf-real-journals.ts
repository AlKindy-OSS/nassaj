/**
 * REAL workflow journal fixtures (ADR-053 test mandate: source fixtures from an
 * actual transcript, never synthetic — lesson `feedback_synthetic_fixtures_false_confidence`).
 *
 * These are the VERBATIM `started`/`result` rows (real `key` content-hashes and
 * `agentId`s) captured from the two journals on disk during the wf_ef5ba242-b4b
 * incident, identical to the arrays pinned in
 * server/modules/providers/list/claude/__tests__/workflow-reconcile.service.test.ts
 * (the canonical real source). They are duplicated here — not imported across the
 * test-suite boundary — so the liveness/status tests exercise the SAME real key
 * sets the reconcile path proved against, without coupling one test file to
 * another's internals.
 *
 *   - INCIDENT_JOURNAL_LINES  ← wf_ef5ba242-b4b: 16 unique started keys, 15 unique
 *     result keys → exactly ONE orphan key (the last `started`, never matched).
 *     Real behaviour: agentsDone 15 < agentsTotal 16.
 *   - COMPLETED_JOURNAL_LINES ← wf_1ea9f41d-bdf: 7 unique started keys (4 re-started
 *     = retry/escalation), 7 unique result keys, all matched. agentsDone 7 == 7.
 *
 * Only `type`/`key`/`result`-presence are load-bearing for the parser; the real
 * `result` payloads are kept faithfully (content trimmed to a marker for size).
 * No `path` field anywhere, exactly as on disk.
 */

export const INCIDENT_WF_ID = 'wf_ef5ba242-b4b';
export const COMPLETED_WF_ID = 'wf_1ea9f41d-bdf';

/**
 * VERBATIM rows from the incident journal on disk
 * (.../230ab538-.../subagents/workflows/wf_ef5ba242-b4b/journal.jsonl).
 * The very LAST line is the orphan: a `started` key with NO matching `result`.
 */
export const INCIDENT_JOURNAL_LINES: Array<Record<string, unknown>> = [
  { type: 'started', key: 'v2:ab094763ae9d7c4b3b18de57a59a69189d46f50fe7b2fb74b2460e260eeb76f3', agentId: 'a76093b3fc609de4b' },
  { type: 'started', key: 'v2:042a6955ffea14741930b22a7034dfc4d578babc902742d1ac2481b643f86212', agentId: 'ae3f5b6b6e9b6c0c4' },
  { type: 'started', key: 'v2:2b83f4f885f4c7e336932332683c022cd37a8acd54bb693ff8aea68a9d83e279', agentId: 'ac197138d808a8e81' },
  { type: 'started', key: 'v2:1b72a364893ab19cd761c7e6e553364ca5328bc8bc1ebdb314013528b882cf6e', agentId: 'a7306e087e94d697b' },
  { type: 'started', key: 'v2:1c98a46b048503799883571797aeb838b9f189b6bca8d67ed11f3c5de85d7328', agentId: 'a5df3e69c2e51ce28' },
  {
    type: 'result',
    key: 'v2:042a6955ffea14741930b22a7034dfc4d578babc902742d1ac2481b643f86212',
    agentId: 'ae3f5b6b6e9b6c0c4',
    result: { sectionId: 'S3', title: 'S3 — ربط وتفعيل مكوّنات كل مزوّد', content: '## S3 …' },
  },
  {
    type: 'result',
    key: 'v2:1b72a364893ab19cd761c7e6e553364ca5328bc8bc1ebdb314013528b882cf6e',
    agentId: 'a7306e087e94d697b',
    result: { sectionId: 'S4', title: 'S4 — سيناريوهات التشغيل والحالات الحدّية', content: '## S4 …' },
  },
  {
    type: 'result',
    key: 'v2:ab094763ae9d7c4b3b18de57a59a69189d46f50fe7b2fb74b2460e260eeb76f3',
    agentId: 'a76093b3fc609de4b',
    result: { sectionId: 'S1', title: 'جرد المكوّنات وتصميم الواصِف', content: '## S1 …' },
  },
  {
    type: 'result',
    key: 'v2:2b83f4f885f4c7e336932332683c022cd37a8acd54bb693ff8aea68a9d83e279',
    agentId: 'ac197138d808a8e81',
    result: { sectionId: 'S2', title: 'S2 — آلية التبديل ودورة الحياة', content: '## S2 …' },
  },
  {
    type: 'result',
    key: 'v2:1c98a46b048503799883571797aeb838b9f189b6bca8d67ed11f3c5de85d7328',
    agentId: 'a5df3e69c2e51ce28',
    result: { sectionId: 'S5', title: 'المعمارية الكلية والترحيل والاختبار والمخاطر', content: '## S5 …' },
  },
  { type: 'started', key: 'v2:876532f4dca6561c46045617c9214072d894175a0be3421f0958853270480a12', agentId: 'a510fb3fae50115be' },
  { type: 'started', key: 'v2:1f0c926644374bbb36cae28ed267800c5134fb7c1e76263abbcf1774ba17f31b', agentId: 'afa5e98333c8da3aa' },
  { type: 'started', key: 'v2:925fbdd29a30909cd6bdab3a7a025d1f939ac67b9730772f092a69188747f1aa', agentId: 'a215f19c870d26864' },
  { type: 'result', key: 'v2:925fbdd29a30909cd6bdab3a7a025d1f939ac67b9730772f092a69188747f1aa', agentId: 'a215f19c870d26864', result: {} },
  { type: 'result', key: 'v2:876532f4dca6561c46045617c9214072d894175a0be3421f0958853270480a12', agentId: 'a510fb3fae50115be', result: {} },
  { type: 'result', key: 'v2:1f0c926644374bbb36cae28ed267800c5134fb7c1e76263abbcf1774ba17f31b', agentId: 'afa5e98333c8da3aa', result: {} },
  { type: 'started', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a0d64a57b00abd9dc' },
  { type: 'started', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a7c59c75f7fb21d40' },
  { type: 'result', key: 'v2:769b30fa862a21749a7623e9a953b9762fe7bfeaa48512cb72cdb4e8c4a88b41', agentId: 'a7c59c75f7fb21d40', result: {} },
  { type: 'started', key: 'v2:a78105d2406d19203cfc6650f4dbff20b2a257b70ecfba00bbfcede90c56117c', agentId: 'a9fec5e54e3fa17a7' },
  { type: 'started', key: 'v2:1e8c259f5a2a24d0bbb14a203fdddb4d980319cb9a4de58003357095dbc8506d', agentId: 'a3059bdd260c7bf6a' },
  { type: 'started', key: 'v2:e178f425ad277b02bea5e509c12e41525017102e559b67d38bf610d76b1fe1d7', agentId: 'aa74d739b57da23fa' },
  { type: 'started', key: 'v2:85c632271107e0bd62dcfc6df9cd46c29510679011b9d0029313a2bf07ad0632', agentId: 'a5bfb770ff8e524ba' },
  { type: 'started', key: 'v2:06dbc3ac55dec8c8c2a56a5dd9719b2d2195a49e87ad70d79728313dd85a36ae', agentId: 'a1060f8e4758cc059' },
  { type: 'started', key: 'v2:de2a1a46e46877c4bdb07dbe9a71d0b7abf400ba82e2071ad378f5a0fcdfa75b', agentId: 'a836859f588c8f018' },
  { type: 'result', key: 'v2:06dbc3ac55dec8c8c2a56a5dd9719b2d2195a49e87ad70d79728313dd85a36ae', agentId: 'a1060f8e4758cc059', result: {} },
  { type: 'result', key: 'v2:1e8c259f5a2a24d0bbb14a203fdddb4d980319cb9a4de58003357095dbc8506d', agentId: 'a3059bdd260c7bf6a', result: {} },
  { type: 'result', key: 'v2:de2a1a46e46877c4bdb07dbe9a71d0b7abf400ba82e2071ad378f5a0fcdfa75b', agentId: 'a836859f588c8f018', result: {} },
  { type: 'result', key: 'v2:e178f425ad277b02bea5e509c12e41525017102e559b67d38bf610d76b1fe1d7', agentId: 'aa74d739b57da23fa', result: {} },
  { type: 'result', key: 'v2:a78105d2406d19203cfc6650f4dbff20b2a257b70ecfba00bbfcede90c56117c', agentId: 'a9fec5e54e3fa17a7', result: {} },
  { type: 'result', key: 'v2:85c632271107e0bd62dcfc6df9cd46c29510679011b9d0029313a2bf07ad0632', agentId: 'a5bfb770ff8e524ba', result: {} },
  // THE ORPHAN: started, never produced a result (subagent left hanging at restart).
  { type: 'started', key: 'v2:2c15018a37b4a02999c95273e0db3d39e83efd4f33f35d3a9e22f02c247491c7', agentId: 'afddffbb69a48213d' },
];

/**
 * VERBATIM rows from the completed journal on disk
 * (.../41d650d6-.../subagents/workflows/wf_1ea9f41d-bdf/journal.jsonl).
 * 11 started lines collapse to 7 unique keys; every started key has a result.
 */
export const COMPLETED_JOURNAL_LINES: Array<Record<string, unknown>> = [
  { type: 'started', key: 'v2:b8e26b51cc782533ee6273cb9f9d876299a34a6efa537cf1927a85a73f182f19', agentId: 'a0ae48768834f44d9' },
  { type: 'result', key: 'v2:b8e26b51cc782533ee6273cb9f9d876299a34a6efa537cf1927a85a73f182f19', agentId: 'a0ae48768834f44d9', result: {} },
  { type: 'started', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a6dd1b79a68ba21b1' },
  { type: 'started', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'abe7ccc5aab802788' },
  { type: 'started', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a3c1f8e93580d1cdc' },
  { type: 'started', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'a72487559602a95a1' },
  { type: 'result', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'abe7ccc5aab802788', result: {} },
  { type: 'result', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a3c1f8e93580d1cdc', result: {} },
  { type: 'result', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'a72487559602a95a1', result: {} },
  { type: 'started', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a8aec7d281e6ec72b' },
  { type: 'started', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'aeebb22d41d718435' },
  { type: 'started', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a59d0205755883954' },
  { type: 'started', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'a358e0f4b054189ae' },
  { type: 'result', key: 'v2:4cdb4da151a3191f2f2d671c7c60eb2d0c409fbc7fc4b77f1ea642f84766001f', agentId: 'a358e0f4b054189ae', result: {} },
  { type: 'result', key: 'v2:497df00c04b23b12b10fb8898355ca24a67a3ca320b06d2fb2549db21b6412d7', agentId: 'a59d0205755883954', result: {} },
  { type: 'result', key: 'v2:1bf42a5f009e90c1511ef4c46210be84433d951e05557f0afebf88c1272b71e9', agentId: 'aeebb22d41d718435', result: {} },
  { type: 'result', key: 'v2:0ea2f41fd3a3b1997e00c749f94d90e4dfbcc5e947a7bbe820162308c7bc4503', agentId: 'a8aec7d281e6ec72b', result: {} },
  { type: 'started', key: 'v2:56432bd40bb95d0232b4ab713a6f7c8675b0ebf77a113132b2a25ee00f3f6836', agentId: 'a5af5c06c82c65f06' },
  { type: 'started', key: 'v2:6d1f406fc027c73ce3b1525aeb57fe1438619ca449453fb162a2927975fbf264', agentId: 'a5c9110eaedc02d2d' },
  { type: 'result', key: 'v2:6d1f406fc027c73ce3b1525aeb57fe1438619ca449453fb162a2927975fbf264', agentId: 'a5c9110eaedc02d2d', result: {} },
  { type: 'result', key: 'v2:56432bd40bb95d0232b4ab713a6f7c8675b0ebf77a113132b2a25ee00f3f6836', agentId: 'a5af5c06c82c65f06', result: {} },
];

/** Serializes fixture rows to JSONL exactly as they appear on disk. */
export function toJsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}
