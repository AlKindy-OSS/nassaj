/** Bounds stalled local inference; retry/status noise does not count as useful output. */
export function watchLocalModelProgress(child, onTimeout, timeoutMs = 10 * 60 * 1000) {
  let timer = null;
  let escalation = null;
  let expired = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    timer = null;
    escalation = null;
  };
  const touch = () => {
    if (expired) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      onTimeout();
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
      escalation.unref();
    }, timeoutMs);
    timer.unref();
  };
  child.once('close', clear);
  child.once('error', clear);
  touch();
  return { touch, clear };
}
