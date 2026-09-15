// WebKit can compose Hangul by replacing textarea text without composition* events.
// xterm 6 handles insertText but drops insertReplacementText (upstream #5704).
// Keep the editable Hangul tail in the native textarea until it is committed;
// never send intermediate jamo and try to repair them in the remote shell.
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/u;
const JAMO = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]+$/u;
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
const graphemes = (text) => segmenter
  ? Array.from(segmenter.segment(text), ({ segment }) => segment) : Array.from(text);
const normalize = (text) => text.replace(/\u00a0/g, ' ');

export const isIosWebKit = (nav = navigator) => (
  /AppleWebKit/i.test(nav.userAgent || '')
  && (/iP(?:hone|ad|od)/i.test(nav.userAgent || '')
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1))
);

const passthrough = () => ({ active: false, prepareInput: (data) => data, dispose() {} });

export default function attachIosHangulInput(term, { enabled = isIosWebKit() } = {}) {
  const textarea = term.textarea;
  const root = term.element;
  if (!enabled || !textarea || !root || term.options.screenReaderMode) return passthrough();

  // Listen on an ancestor in capture phase: xterm's own textarea listeners also
  // use capture, and must not run its asynchronous keyCode=229 diff in parallel.
  let sent = '';
  let pending = '';
  let owned = false;
  let baseline = normalize(textarea.value);
  let nativeComposition = false;
  let ignoreInputType = null;
  let disposed = false;
  const listeners = [];
  const preview = document.createElement('span');
  preview.className = 'terminal-hangul-preview';
  preview.setAttribute('aria-hidden', 'true');
  Object.assign(preview.style, {
    position: 'absolute', display: 'none', pointerEvents: 'none',
    whiteSpace: 'pre', zIndex: '10', borderBottom: '1px solid currentColor',
  });
  const screen = root.querySelector('.xterm-screen');
  screen?.appendChild(preview);

  const paint = () => {
    preview.textContent = pending;
    const buffer = term.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    const width = cell?.width || (screen?.clientWidth / term.cols);
    const height = cell?.height || (screen?.clientHeight / term.rows);
    const visible = pending && row >= 0 && row < term.rows && width && height;
    Object.assign(preview.style, {
      display: visible ? 'block' : 'none',
      left: `${Math.min(buffer.cursorX, term.cols - 1) * width}px`,
      top: `${row * height}px`, lineHeight: `${height}px`,
      fontFamily: term.options.fontFamily, fontSize: `${term.options.fontSize}px`,
      color: term.options.theme?.foreground || '#fff',
      background: term.options.theme?.background || '#000',
    });
  };

  const emit = (data) => {
    if (!data || disposed) return;
    term.input(data, true);
  };

  const reset = () => {
    sent = pending = baseline = '';
    owned = false;
    nativeComposition = false;
    textarea.value = '';
    paint();
  };

  // Also used by toolbar/programmatic input, which bypasses DOM key events.
  // Return one payload so a queued Enter cannot overtake its last syllable.
  const prepareInput = (data) => {
    if (!owned || typeof data !== 'string' || !data) return data;
    if (data === '\x7f' || data === '\b') {
      if (pending) {
        pending = graphemes(pending).slice(0, -1).join('');
        textarea.value = sent + pending;
        paint();
        return '';
      }
    }
    const prefix = (data === '\x03' || data === '\x1b') ? '' : pending;
    reset();
    return prefix + data;
  };

  const stop = (event) => event.stopImmediatePropagation();
  const listen = (type, handler) => {
    const wrapped = (event) => { if (event.target === textarea) handler(event); };
    root.addEventListener(type, wrapped, true);
    listeners.push(() => root.removeEventListener(type, wrapped, true));
  };

  const startOwned = () => {
    if (!owned) { sent = baseline; owned = true; }
  };

  const reconcile = (composing = nativeComposition) => {
    startOwned();
    const value = normalize(textarea.value);
    // A replacement may move a 받침 into the next syllable (간 -> 가나).
    // Comparing the complete textarea, rather than concatenating event.data,
    // retains that correction and also handles selection replacement/deletion.
    const before = graphemes(sent);
    const after = graphemes(value);
    let common = 0;
    while (common < before.length && before[common] === after[common]) common++;
    let output = '\x7f'.repeat(before.length - common);
    sent = before.slice(0, common).join('');
    const remaining = after.slice(common);
    let pendingStart = remaining.length;
    if (composing) pendingStart = 0;
    else if (HANGUL.test(remaining.at(-1) || '')) {
      pendingStart--;
      // A keyboard may insert ㅁ after 치 before replacing 치ㅁ with 침.
      // Keep the preceding syllable editable through that intermediate event.
      while (pendingStart > 0 && JAMO.test(remaining[pendingStart])
        && HANGUL.test(remaining[pendingStart - 1])) pendingStart--;
    }
    pending = remaining.slice(pendingStart).join('');
    const committed = remaining.slice(0, pendingStart).join('');
    sent += committed;
    output += committed;
    // An empty tail can be the deletion half of a replacement, not a commit.
    // Never write value/selection in response to native edits: doing so ends
    // WebKit's editing context and can detach the next 받침. Retain the field
    // (including the sent prefix) until an explicit terminal action or blur.
    paint();
    emit(output);
  };
  const readInput = (event) => {
    if (!/^(insert|delete)/.test(event.inputType || '')) return;
    stop(event);
    if (ignoreInputType === event.inputType) { ignoreInputType = null; return; }
    reconcile(nativeComposition || event.isComposing);
  };

  listen('keydown', (event) => {
    if (nativeComposition || event.isComposing) { stop(event); return; }
    if (!owned) baseline = normalize(textarea.value);
    const printable = event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const unknown = !event.key || ['Unidentified', 'Process', 'Dead'].includes(event.key);
    if (event.keyCode === 229 || unknown || printable || (event.key === 'Backspace' && textarea.value)) {
      // Allow the browser's default edit, but keep xterm from sending it early.
      stop(event);
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    if (owned) {
      const cancel = event.key === 'Escape' || (event.ctrlKey && event.key?.toLowerCase() === 'c');
      const data = cancel ? '' : pending;
      reset();
      emit(data);
    }
    // The key itself still follows xterm's normal path. Do not intercept all
    // onData events: that stream also contains automatic terminal query replies.
  });
  listen('keyup', (event) => {
    // xterm refocuses its textarea on keyup. Native edits own the field while
    // there is retained context; no focus/selection churn between IME updates.
    if (owned || nativeComposition || event.isComposing || event.keyCode === 229) stop(event);
  });
  listen('keypress', (event) => {
    if (nativeComposition || event.isComposing || (!event.ctrlKey && !event.metaKey && !event.altKey)) stop(event);
  });
  listen('beforeinput', (event) => {
    ignoreInputType = null;
    if (nativeComposition || event.isComposing || event.inputType === 'insertCompositionText') return;
    if (!owned) baseline = normalize(textarea.value);
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      // Some iOS keyboards emit beforeinput without a usable Enter keydown.
      event.preventDefault(); stop(event);
      const data = prepareInput('\r');
      ignoreInputType = event.inputType;
      emit(data);
    } else if (event.inputType === 'deleteContentBackward' && !textarea.value) {
      // An empty helper textarea cannot delete anything, but the remote shell can.
      event.preventDefault(); stop(event);
      ignoreInputType = event.inputType;
      emit('\x7f');
    }
  });
  listen('input', readInput);
  listen('compositionstart', (event) => {
    stop(event);
    if (!owned) baseline = normalize(textarea.value);
    startOwned();
    // Some keyboards mix replacement input with composition events for the
    // same syllable. Keep a single owner and never flush at this transition.
    nativeComposition = true;
  });
  listen('compositionupdate', stop);
  listen('compositionend', (event) => {
    stop(event);
    nativeComposition = false;
    reconcile();
  });
  listen('blur', () => {
    const data = pending;
    reset();
    emit(data);
  });

  // Clipboard, uploaded file paths and app helpers all use the public paste API.
  // Commit first, then let xterm preserve its bracketed-paste protocol unchanged.
  const originalPaste = term.paste;
  const paste = (data) => {
    if (owned) {
      const prefix = pending;
      reset();
      emit(prefix);
    }
    originalPaste.call(term, data);
  };
  term.paste = paste;

  const render = term.onRender?.(paint);
  const resize = term.onResize?.(paint);
  return {
    active: true,
    prepareInput,
    dispose() {
      disposed = true;
      listeners.forEach((remove) => remove());
      render?.dispose(); resize?.dispose(); preview.remove();
      if (term.paste === paste) term.paste = originalPaste;
      // Never send unfinished input during pane destruction/reconnection.
      sent = pending = '';
    },
  };
}
