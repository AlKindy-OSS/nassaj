/** لقطة بثّ تراكمية لجلسة واحدة، تُبنى قبل React batching. */
export type StreamSnapshot = {
  seq: number;
  text: string;
  ended: boolean;
  frame: any;
  incomplete?: boolean;
};

export type StreamFrame = StreamSnapshot & {
  completed?: readonly StreamSnapshot[];
  droppedBeforeSeq?: number;
  lastServerSequence?: number;
  evictionGap?: boolean;
  /** Highest server sequence per recent run id: tells a restarted line from a late frame. */
  runSequences?: Readonly<Record<string, number>>;
};

const MAX_TRACKED_RUNS = 16;

type EvictedStreamHead = Pick<StreamFrame, 'seq' | 'lastServerSequence'>;

export type StreamFrameMap = ReadonlyMap<string, StreamFrame> & {
  /** آخر 64 جلسة مقلمة فقط؛ بيانات استرداد بلا نصوص. */
  evictedHeads?: ReadonlyMap<string, EvictedStreamHead>;
};

function trackRun(
  tracked: Readonly<Record<string, number>>,
  run: string,
  sequence: number,
): Record<string, number> {
  const { [run]: previous, ...rest } = tracked;
  const next = { ...rest, [run]: Math.max(previous ?? 0, sequence) };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TRACKED_RUNS))) delete next[key];
  return next;
}

/** الحدّ: إدخال واحد فقط لكل جلسة، مع تقليم الأقدم. */
export const MAX_STREAM_FRAMES = 64;

/**
 * يُبقي سجلّ الاستهلاك محصوراً في الجلسات الموجودة في لقطة البث الحالية.
 * الخريطة مرجع طويل العمر داخل الخطّاف، لذلك لا يكفي تقليم لقطة السياق وحدها.
 */
export function pruneProcessedStreamSeqs(
  processed: Map<string, number>,
  current: StreamFrameMap,
): void {
  for (const sessionId of processed.keys()) {
    if (!current.has(sessionId)) processed.delete(sessionId);
  }
  if (processed.size <= MAX_STREAM_FRAMES) return;
  const bySeqAsc = [...processed.entries()].sort((a, b) => a[1] - b[1]);
  for (const [sessionId] of bySeqAsc.slice(0, processed.size - MAX_STREAM_FRAMES)) {
    processed.delete(sessionId);
  }
}

/**
 * يجمع الأجزاء ويحفظ النهايات السابقة ضمن ميزانية عالمية قبل React batching.
 * أول جزء بعد نهاية سابقة يبدأ جولة جديدة،
 * و`stream_end` يحفظ النص المجمّع ويعلّم اللقطة بالنهاية. كما تمرّ رسالة
 * المساعد النصية النهائية في القناة نفسها: Codex قد يبعثها ثم `complete` في
 * دفعة React واحدة، فلا يجوز تركها في فتحة `latestMessage` الأحادية.
 */
export function applyStreamFrame(
  previous: StreamFrameMap,
  frame: any,
  seq: number,
): StreamFrameMap {
  const sessionId = typeof frame?.sessionId === 'string' ? frame.sessionId : '';
  if (!sessionId) return previous;
  const kind = frame?.kind;
  const isPersistableAssistantText = kind === 'text'
    && frame?.role === 'assistant'
    && typeof frame?.content === 'string'
    && frame.content.length > 0;
  if (kind !== 'stream_delta' && kind !== 'stream_end' && !isPersistableAssistantText) {
    return previous;
  }

  const prior = previous.get(sessionId);
  const evicted = previous.evictedHeads?.get(sessionId);
  const serverSequence = typeof frame.sequence === 'number' && Number.isFinite(frame.sequence)
    ? frame.sequence : undefined;
  const run = frame.responseToMessageId ?? frame.clientMsgId;
  const priorRun = prior?.frame?.responseToMessageId ?? prior?.frame?.clientMsgId;
  const changedRun = Boolean(run && priorRun && run !== priorRun);
  const runSequences = prior?.runSequences ?? {};
  // The server's per-session sequence line restarts at 1 when its registry
  // entry is dropped (post-run retention elapsed, server restart). A frame of a
  // run NOT SEEN BEFORE is therefore never a duplicate, however low its
  // sequence. A frame of an already-seen run is judged against that run's own
  // last sequence, so a late frame of an earlier run cannot finalize or split
  // the run now streaming.
  const knownRun = run && Object.prototype.hasOwnProperty.call(runSequences, run);
  const lastServerSequence = knownRun
    ? runSequences[run]
    : changedRun && run !== priorRun
      ? undefined
      : prior?.lastServerSequence ?? evicted?.lastServerSequence;
  if (serverSequence != null && lastServerSequence != null
    && serverSequence <= lastServerSequence) return previous;

  // A redundant terminal marker must not create a second synthetic response.
  if (kind === 'stream_end' && prior?.ended) return previous;
  const sameFinal = isPersistableAssistantText && prior?.ended
    && prior.frame.kind === 'text' && frame.id && prior.frame.id === frame.id;
  const startsNext = prior && !sameFinal && (changedRun || (prior.ended
    && (kind === 'stream_delta' || isPersistableAssistantText)));
  const completed = [...(prior?.completed ?? [])];
  if (startsNext && prior.text) {
    completed.push({ seq: prior.seq, text: prior.text, ended: true, frame: prior.frame,
      ...(prior.incomplete ? { incomplete: true } : {}) });
  }
  const delta = kind === 'stream_delta' && typeof frame.content === 'string' ? frame.content : '';
  const text = kind === 'stream_delta'
    ? `${prior && !prior.ended && !changedRun ? prior.text : ''}${delta}`
    : isPersistableAssistantText ? frame.content : (prior?.text ?? '');
  const next = new Map(previous) as Map<string, StreamFrame> & Pick<StreamFrameMap, 'evictedHeads'>;
  const evictedHeads = new Map(previous.evictedHeads);
  evictedHeads.delete(sessionId);
  next.set(sessionId, {
    ...(evicted || prior?.evictionGap ? { evictionGap: true } : {}),
    ...((evicted || prior?.incomplete) && !isPersistableAssistantText ? { incomplete: true } : {}),
    ...(run && serverSequence != null
      ? { runSequences: trackRun(runSequences, run, serverSequence) }
      : prior?.runSequences ? { runSequences: prior.runSequences } : {}),
    seq, text, ended: kind === 'stream_end' || isPersistableAssistantText,
    frame: prior && !changedRun && !startsNext && !isPersistableAssistantText
      ? { ...frame,
        ...(run == null && priorRun ? { responseToMessageId: priorRun } : {}),
        ...(frame.provider == null && prior.frame.provider ? { provider: prior.frame.provider } : {}),
        ...(frame.coordinatorId == null && prior.frame.coordinatorId != null
          ? { coordinatorId: prior.frame.coordinatorId } : {}),
        ...(frame.originKind == null && prior.frame.originKind
          ? { originKind: prior.frame.originKind } : {}),
        ...((typeof frame.model !== 'string' || !frame.model.trim()) && prior.frame.model
          ? { model: prior.frame.model } : {}),
      } : frame,
    ...(completed.length ? { completed } : {}),
    ...((prior?.droppedBeforeSeq ?? evicted?.seq)
      ? { droppedBeforeSeq: prior?.droppedBeforeSeq ?? evicted?.seq } : {}),
    ...(serverSequence != null || lastServerSequence != null
      ? { lastServerSequence: serverSequence ?? lastServerSequence } : {}),
  });
  if (next.size > MAX_STREAM_FRAMES) {
    const bySeqAsc = [...next.entries()].sort((a, b) => a[1].seq - b[1].seq);
    for (const [key, entry] of bySeqAsc.slice(0, next.size - MAX_STREAM_FRAMES)) {
      evictedHeads.set(key, { seq: entry.seq, lastServerSequence: entry.lastServerSequence });
      next.delete(key);
    }
  }
  // Bounded metadata window: no text retention and no claim of indefinite replay.
  while (evictedHeads.size > MAX_STREAM_FRAMES) {
    evictedHeads.delete(evictedHeads.keys().next().value!);
  }
  if (evictedHeads.size) next.evictedHeads = evictedHeads;
  // Global budget: at most 64 completed snapshots plus 64 session heads.
  // Overflow is explicit so a consumer that missed the window reconciles REST.
  const retained = [...next.entries()].flatMap(([id, entry]) =>
    (entry.completed ?? []).map(snapshot => ({ id, snapshot })));
  retained.sort((a, b) => a.snapshot.seq - b.snapshot.seq);
  for (const { id, snapshot } of retained.slice(0, Math.max(0, retained.length - MAX_STREAM_FRAMES))) {
    const entry = next.get(id)!;
    next.set(id, { ...entry,
      completed: entry.completed!.filter(item => item.seq !== snapshot.seq),
      droppedBeforeSeq: Math.max(entry.droppedBeforeSeq ?? 0, snapshot.seq),
    });
  }
  return next;
}
