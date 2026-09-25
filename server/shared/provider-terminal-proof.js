import { WRITER_TARGET } from './writer-target.js';

/** Intercept normalized provider errors without changing the writer's receiver or session methods. */
export function observeProviderErrors(writer, onError) {
  if (!writer)
    return writer;
  return new Proxy(writer, {
    get(target, key) {
      if (key === WRITER_TARGET)
        return target;
      if (key === 'send')
        return message => {
          if (message?.kind === 'error')
            onError(message.content || 'Provider reported an error'); return target.send(message);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
/** A later zero close cannot erase a preceding timeout, provider error or explicit abort. */
export function providerSucceeded(code, failure, aborted) { return code === 0 && !failure && !aborted; }
