// Actual xterm bundle + real browser DOM. Replays WebKit Hangul replacement
// events; this is not a substitute for an iPhone software-keyboard check.
// Run: node scripts/ime-smoke.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { outputFiles } = await build({
  entryPoints: [path.join(root, 'src/components/terminal/attachIosHangulInput.js')],
  bundle: true, write: false, format: 'iife', globalName: 'HangulBridge',
});

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="terminal" style="width:800px;height:400px"></div>');
    await page.addStyleTag({ path: path.join(root, 'node_modules/@xterm/xterm/css/xterm.css') });
    await page.addScriptTag({ path: path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.evaluate(() => {
      window.mount = (patched) => {
        window.bridge?.dispose();
        window.term?.dispose();
        const term = window.term = new window.Terminal({ cols: 80, rows: 20 });
        term.open(document.querySelector('#terminal'));
        window.chunks = [];
        term.onData((data) => window.chunks.push(data));
        window.bridge = patched ? window.HangulBridge.default(term, { enabled: true }) : null;
        term.focus();
      };
      window.edit = (value, inputType = 'insertReplacementText', data = value, keyCode = 229) => {
        const ta = window.term.textarea;
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Unidentified', keyCode, bubbles: true, cancelable: true,
        }));
        const before = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true });
        if (ta.dispatchEvent(before)) {
          ta.value = value;
          ta.setSelectionRange(value.length, value.length);
          ta.dispatchEvent(new InputEvent('input', { inputType, data, composed: true, bubbles: true }));
        }
        ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }));
      };
    });

    // Establish that the unmodified, installed xterm mishandles this trace.
    await page.evaluate(() => window.mount(false));
    for (const [value, type] of [['ㄱ', 'insertText'], ['가', 'insertReplacementText']]) {
      await page.evaluate(([v, t]) => window.edit(v, t), [value, type]);
      await page.waitForTimeout(20);
    }
    await page.keyboard.press('Enter');
    const before = await page.evaluate(() => window.chunks.join(''));
    assert.notEqual(before, '가\r', 'The baseline must reproduce the missing composition');

    await page.evaluate(() => window.mount(true));
    for (const value of ['ㄱ', '가', '간', '가나']) {
      await page.evaluate((v) => window.edit(v, v === 'ㄱ' ? 'insertText' : 'insertReplacementText'), value);
      await page.waitForTimeout(20);
    }
    assert.equal(await page.evaluate(() => window.chunks.join('')), '가');
    assert.equal(await page.locator('.terminal-hangul-preview').textContent(), '나');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '가나\r');

    // Real browser keyboard events, not manually dispatched, must still work.
    await page.keyboard.type('echo abc 123');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '가나\recho abc 123\x7f\r');

    await page.evaluate(() => window.mount(true));
    for (const value of ['ㅎ', '하', '한']) await page.evaluate((v) => window.edit(v), value);
    await page.evaluate(() => window.edit('하', 'deleteContentBackward', null));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '하\r');

    // User-reported 받침 sequence, including provisional standalone consonants,
    // unidentified keyCode=0 and native replacement deletion between frames.
    await page.evaluate(() => window.mount(true));
    for (const value of ['ㅂ', '바', '받', '받ㅊ', '받치', '받치ㅁ', '받침',
      '받침ㅇ', '받침이', '받침이ㅆ', '받침있', '받침있ㄴ', '받침있느',
      '받침있느ㄴ', '받침있는', '받침있는ㄱ', '받침있는게']) {
      await page.evaluate((v) => window.edit(v, 'insertReplacementText', v, 0), value);
      assert.equal(await page.evaluate(() => window.term.textarea.value), value);
      await page.waitForTimeout(20);
    }
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '받침있는게\r');

    await page.evaluate(() => window.mount(true));
    await page.evaluate(() => {
      window.edit('받치');
      window.edit('받', 'deleteContentBackward', null);
    });
    assert.equal(await page.evaluate(() => window.term.textarea.value), '받');
    await page.evaluate(() => window.edit(window.term.textarea.value + '침', 'insertText', '침'));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '받침\r');

    // Switching from replacement input to composition* must retain 치 until
    // the native keyboard replaces it with 침, with no delayed xterm duplicates.
    await page.evaluate(() => window.mount(true));
    await page.evaluate(() => {
      window.edit('받치');
      const ta = window.term.textarea;
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.value = '받침';
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '침', isComposing: true }));
      ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '침' }));
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '침' }));
    });
    await page.waitForTimeout(30);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '받침\r');

    // Standard composition events and rapid syllables use the same owner.
    await page.evaluate(() => window.mount(true));
    await page.evaluate(async () => {
      const ta = window.term.textarea;
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한' }));
      ta.value = '한';
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '한', isComposing: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.chunks.join('')), '한\r');

    await page.evaluate(() => window.mount(true));
    await page.evaluate(() => new Promise((resolve) => window.term.write('\x1b[?2004h', resolve)));
    await page.evaluate(() => { window.edit('한'); window.term.paste('hello\n'); });
    assert.equal(await page.evaluate(() => window.chunks.join('')), '한\x1b[200~hello\r\x1b[201~');

    console.log(`${engine.name()}: Hangul replacement, 받침, delete, Enter, ASCII, native composition and bracketed paste passed`);
  } finally {
    await browser.close();
  }
}
