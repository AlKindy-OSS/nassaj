/** Stable native transcript identity shared by history and the terminal timing writer. */
export function agyTranscriptMessageId(sessionId, stepIndex) {
  return typeof sessionId === 'string' && sessionId.length > 0 && Number.isSafeInteger(stepIndex) && stepIndex >= 0
    ? `antigravity_${sessionId}_${stepIndex}` : null;
}
/** Select only this turn's last completed planner step; malformed/ambiguous evidence never grants timing. */
export function finalAgyTranscriptMessage(transcript, sessionId, baseline) {
  if (!Number.isSafeInteger(baseline) || baseline < -1)
    return null;
  const entries = [];
  const indices = new Set();
  for (const line of transcript.split('\n')) {
    if (!line.trim())
      continue;
    let entry;
    try {
      entry = JSON.parse(line);
    }
    catch {
      return null;
    }
    if (!Number.isSafeInteger(entry.step_index) || entry.step_index < 0)
      return null;
    if (indices.has(entry.step_index))
      return null;
    indices.add(entry.step_index);
    if (entry.step_index > baseline)
      entries.push(entry);
  }
  entries.sort((a, b) => a.step_index - b.step_index);
  const planners = entries.filter(entry => entry.type === 'PLANNER_RESPONSE' && entry.source === 'MODEL');
  const last = planners.at(-1);
  if (!last || last.status !== 'DONE' || typeof last.content !== 'string' || !last.content.trim()
    || entries.at(-1)?.step_index !== last.step_index)
    return null;
  return { id: agyTranscriptMessageId(sessionId, last.step_index), content: last.content.trim() };
}
