import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import attachIosHangulInput, { isIosWebKit } from './attachIosHangulInput';

describe('iOS Hangul input', () => {
  let term, textarea, root, bridge, nativeInput, nativeKey, render;
  const sent = () => term.input.mock.calls.map(([text]) => text).join('');
  const preview = () => root.querySelector('.terminal-hangul-preview');
  const key = (key, options = {}) => textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...options,
  }));
  const edit = (value, inputType = 'insertText', data = value, options = {}) => {
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data, ...options });
    const accepted = textarea.dispatchEvent(before);
    if (accepted) {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data, ...options }));
    }
    return accepted;
  };
  const compose = (...values) => values.forEach((value, i) => {
    key('Unidentified', { keyCode: 229 });
    edit(value, i ? 'insertReplacementText' : 'insertText');
  });

  beforeEach(() => {
    root = document.createElement('div');
    root.innerHTML = '<div class="xterm-screen"><div><textarea></textarea></div></div>';
    document.body.appendChild(root);
    textarea = root.querySelector('textarea');
    nativeInput = vi.fn();
    nativeKey = vi.fn();
    // xterm registers first, and uses capture on the textarea itself.
    textarea.addEventListener('input', nativeInput, true);
    textarea.addEventListener('keydown', nativeKey, true);
    term = {
      element: root, textarea, rows: 24, cols: 80,
      options: { fontSize: 16, fontFamily: 'monospace', theme: {} },
      buffer: { active: { cursorX: 2, cursorY: 0, baseY: 0, viewportY: 0 } },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 18 } } } } },
      input: vi.fn(), paste: vi.fn(),
      onRender: vi.fn((handler) => { render = handler; return { dispose: vi.fn() }; }),
    };
    bridge = attachIosHangulInput(term, { enabled: true });
  });
  afterEach(() => { bridge.dispose(); root.remove(); vi.useRealTimers(); });

  it('holds ㄱ -> 가 and sends the completed syllable before Enter', () => {
    compose('ㄱ', '가');
    expect(sent()).toBe('');
    expect(textarea.value).toBe('가');
    expect(preview()).toHaveTextContent('가');
    expect(preview().style.display).toBe('block');
    expect(nativeInput).not.toHaveBeenCalled();
    expect(nativeKey).not.toHaveBeenCalled();
    key('Enter', { keyCode: 13 });
    expect(sent()).toBe('가');
    expect(nativeKey).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');
  });

  it('sends one Enter when iOS follows keydown with insertLineBreak', () => {
    nativeKey.mockImplementation((event) => {
      if (event.key === 'Enter') term.input('\r', true);
    });
    compose('ㅎ', '한');

    key('Enter', { keyCode: 13 });
    edit('한\n', 'insertLineBreak', null);

    expect(sent()).toBe('한\r');
  });

  it('commits pending text when Enter arrives during native composition', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    edit('한', 'insertCompositionText', '한', { isComposing: true });

    key('Enter', { keyCode: 13, isComposing: true });

    expect(sent()).toBe('한\r');
  });

  it('handles 받침 moving to the next syllable using the textarea, not event.data', () => {
    compose('ㄱ', '가', '간', '가나');
    expect(sent()).toBe('가');
    expect(preview()).toHaveTextContent('나');
    expect(bridge.prepareInput('\r')).toBe('나\r');
    expect(sent()).toBe('가');
  });

  it('handles double 받침 and space without detached jamo or duplication', () => {
    compose('ㄷ', '다', '달', '닭', '달기');
    edit('달기 ', 'insertText', ' ');
    expect(sent()).toBe('달기 ');
    expect(textarea.value).toBe('달기 ');
    expect(bridge.prepareInput('\r')).toBe('\r');
  });

  it('keeps the native editing context through delete-then-insert replacements', () => {
    compose('받', '받치');
    const write = vi.spyOn(textarea, 'value', 'set');
    edit('받', 'deleteContentBackward', null);
    // Only the simulated browser edit may write the field. Even assigning the
    // same value can terminate WebKit's marked text/selection.
    expect(write.mock.calls).toEqual([['받']]);
    expect(textarea.value).toBe('받');
    edit(textarea.value + '침', 'insertText', '침');
    expect(sent() + bridge.prepareInput('\r')).toBe('받침\r');
    write.mockRestore();
  });

  it('does not commit 받침있는게 on unidentified or Process keys between updates', () => {
    const values = ['ㅂ', '바', '받', '받ㅊ', '받치', '받침', '받침ㅇ',
      '받침이', '받침있', '받침있ㄴ', '받침있느', '받침있는', '받침있는ㄱ', '받침있는게'];
    for (const [index, value] of values.entries()) {
      const previous = textarea.value;
      key(index % 2 ? 'Unidentified' : 'Process', { keyCode: 0 });
      expect(textarea.value).toBe(previous);
      edit(value, index ? 'insertReplacementText' : 'insertText');
    }
    expect(sent() + bridge.prepareInput('\r')).toBe('받침있는게\r');
  });

  it('keeps a pending syllable when composition events begin during its replacement', () => {
    compose('받', '받치');
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(sent()).toBe('받');
    edit('받침', 'insertCompositionText', '침', { isComposing: true });
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '침' }));
    edit('받침', 'insertText', '침');
    expect(sent() + bridge.prepareInput('\r')).toBe('받침\r');
    expect(nativeInput).not.toHaveBeenCalled();
  });

  it('holds a syllable when a 받침 is temporarily appended as standalone jamo', () => {
    compose('받', '받치', '받치ㅁ');
    expect(sent()).toBe('받');
    expect(preview()).toHaveTextContent('치ㅁ');
    edit('받침', 'insertReplacementText');
    compose('받침이', '받침이ㅆ', '받침있', '받침있느', '받침있느ㄴ', '받침있는', '받침있는게');
    expect(sent() + bridge.prepareInput('\r')).toBe('받침있는게\r');
  });

  it('commits non-Hangul composition once without a trailing input event', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    edit('日本語', 'insertCompositionText', '日本語', { isComposing: true });
    expect(sent()).toBe('');
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
    expect(sent()).toBe('日本語');
    expect(bridge.prepareInput('\r')).toBe('\r');
  });

  it('keeps the final syllable editable when typing pauses', () => {
    vi.useFakeTimers();
    compose('ㅎ', '하');
    vi.advanceTimersByTime(5000);
    edit('한', 'insertReplacementText', '한');
    expect(sent()).toBe('');
    expect(bridge.prepareInput('\r')).toBe('한\r');
  });

  it('lets the native keyboard delete composing jamo before deleting remote text', () => {
    compose('ㅎ', '하', '한');
    key('Backspace', { keyCode: 8 });
    edit('하', 'deleteContentBackward', null);
    edit('ㅎ', 'deleteContentBackward', null);
    edit('', 'deleteContentBackward', null);
    expect(sent()).toBe('');
    expect(nativeKey).not.toHaveBeenCalled();
    edit('', 'deleteContentBackward', null);
    expect(sent()).toBe('\x7f');
  });

  it('can delete across the committed boundary without resending the prefix', () => {
    compose('가', '가나');
    edit('가', 'deleteContentBackward', null);
    edit('', 'deleteContentBackward', null);
    expect(sent()).toBe('가\x7f');
  });

  it('consumes toolbar Backspace locally and commits before arrow keys', () => {
    compose('가');
    expect(bridge.prepareInput('\x7f')).toBe('');
    expect(sent()).toBe('');
    compose('나');
    expect(bridge.prepareInput('\x1b[D')).toBe('나\x1b[D');
  });

  it.each(['\x03', '\x1b'])('cancels the pending syllable for control %j', (control) => {
    compose('한');
    expect(bridge.prepareInput(control)).toBe(control);
    expect(preview().style.display).toBe('none');
  });

  it('handles Enter without a keydown, exactly once', () => {
    compose('한');
    expect(edit('한\n', 'insertLineBreak', null)).toBe(false);
    // A non-cancellable input delivered despite preventDefault must not repeat it.
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
    expect(sent()).toBe('한\r');
  });

  it('passes ordinary text, punctuation and emoji once and normalizes iOS spaces', () => {
    key('a'); edit('a');
    edit('a😀'); edit('a😀\u00a0', 'insertText', '\u00a0');
    compose('a😀\u00a0한'); edit('a😀\u00a0한\u00a0', 'insertText', '\u00a0');
    expect(sent()).toBe('a😀 한 ');
    expect(nativeInput).not.toHaveBeenCalled();
  });

  it('handles real composition events and their trailing input only once', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    edit('한', 'insertCompositionText', '한', { isComposing: true });
    key('Unidentified', { keyCode: 229, isComposing: true });
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
    edit('한', 'insertText', '한');
    expect(nativeInput).not.toHaveBeenCalled();
    expect(nativeKey).not.toHaveBeenCalled();
    expect(sent()).toBe('');
    edit('한a', 'insertText', 'a');
    expect(sent()).toBe('한a');
  });

  it('flushes before paste and preserves the native paste implementation', () => {
    compose('한');
    term.paste('hello\n');
    expect(sent()).toBe('한');
    expect(textarea.value).toBe('');
    bridge.dispose();
    expect(term.paste).toHaveBeenCalledWith('hello\n');
  });

  it('flushes on blur, but never replays pending input when a pane is disposed', () => {
    compose('한');
    textarea.dispatchEvent(new FocusEvent('blur'));
    expect(sent()).toBe('한');
    compose('글');
    bridge.dispose();
    expect(sent()).toBe('한');
    expect(preview()).toBeNull();
  });

  it('tracks cursor movement and hides the preview outside the viewport', () => {
    compose('가');
    term.buffer.active.cursorX = 10;
    render();
    expect(preview().style.left).toBe('80px');
    term.buffer.active.viewportY = 5;
    render();
    expect(preview().style.display).toBe('none');
  });

  it('does not interfere with non-iOS or screen-reader input', () => {
    bridge.dispose();
    const off = attachIosHangulInput(term, { enabled: false });
    edit('가');
    expect(nativeInput).toHaveBeenCalledTimes(1);
    expect(off.prepareInput('x')).toBe('x');
    term.options.screenReaderMode = true;
    const accessible = attachIosHangulInput(term, { enabled: true });
    expect(preview()).toBeNull();
    expect(accessible.prepareInput('x')).toBe('x');
  });

  it('detects iPhone and desktop-mode iPad, but not Android or desktop Safari', () => {
    expect(isIosWebKit({ userAgent: 'iPhone AppleWebKit/605' })).toBe(true);
    expect(isIosWebKit({ userAgent: 'Macintosh AppleWebKit/605', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebKit({ userAgent: 'Android AppleWebKit/537 Chrome' })).toBe(false);
    expect(isIosWebKit({ userAgent: 'Macintosh AppleWebKit/605', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
});
