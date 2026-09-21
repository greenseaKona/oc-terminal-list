// Real xterm + browser geometry: drag, resize and mobile hit testing.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: `
    import React, {useEffect, useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import createXtermInstance from './src/components/terminal/createXtermInstance';
    import ensureStyles from './src/components/terminal/xtermGlobalCss';
    import TerminalScrollbar from './src/components/terminal/TerminalScrollbar';
    import CwdBreadcrumb from './src/components/terminalheader/CwdBreadcrumb';
    import HistoryPanel from './src/components/commandinput/HistoryPanel';
    import {DEFAULT_SETTINGS} from './src/hooks/useSettings';
    import {pushLocalCommand} from './src/utils/commandHistory';
    function App() {
      const container = useRef(); const xtermRef = useRef(); const fitNowRef = useRef();
      const [ready, setReady] = useState(false);
      const [enabled, setEnabled] = useState(DEFAULT_SETTINGS.showTerminalScrollbar);
      const [showInput, setShowInput] = useState(true);
      const [theme, setTheme] = useState({background:'#111111',foreground:'#eeeeee',blue:'#123456'});
      const [historyOpen, setHistoryOpen] = useState(false);
      useEffect(() => {
        ensureStyles();
        const {term, fitAddon} = createXtermInstance({container: container.current,
          settings: {fontSize: 13, smoothScroll: true, predictiveEcho: false},
          theme: {background:'#111', foreground:'#eee'}});
        window.term = xtermRef.current = term;
        window.saveHistory = text => pushLocalCommand('test', text);
        window.fetch = async (url, options = {}) => {
          if (!url.startsWith('/api/command-history')) throw new Error('Unexpected request');
          return {ok:true,json:async()=>({items:[],hasMore:false})};
        };
        fitNowRef.current = window.fitTerminal = () => fitAddon.fit();
        window.scrollCalls = [];
        const scrollToLine = term.scrollToLine.bind(term);
        term.scrollToLine = line => { window.scrollCalls.push(line); scrollToLine(line); };
        window.chunks = []; term.onData(data => window.chunks.push(data));
        setReady(true);
        term.write(['A', 'B', 'C'].map(letter => '\\x1b[48;2;60;64;72m› 질문 '+letter+'\\x1b[0m\\r\\n\\r\\n' + Array.from({length:70}, (_,i) => 'Answer '+letter+' '+i+'\\r\\n').join('')).join('') + '› ');
        return () => term.dispose();
      }, []);
      useEffect(() => {
        if (xtermRef.current) xtermRef.current.options.theme = theme;
      }, [theme]);
      const copy = {
        terminalContextInput:'현재 구간의 질문', terminalInputDismiss:'닫기',
        terminalInputJump:'질문 위치로 이동', terminalInputExpand:'질문 펼치기', terminalInputCollapse:'질문 접기',
      };
      const headerUi = {surface0:'#23232f',surface1:'#2d2d3c',border:'#45475a',text:'#e4e6f1',
        subtext0:'#a8acc4',muted:'#6c7086',accent:'#89b4fa'};
      return <><div id="cwd-header" style={{width:220,height:28,display:'flex',background:'#15151f'}}>
          <CwdBreadcrumb paneInfo={{tabType:'local',cwd:'/home/ubuntu/app/project/with/a/very/deep/directory/that/is/truncated'}}
            loading={false} disabled={false} ui={headerUi} t={k=>k} />
        </div>
        <button id="toggle" onClick={() => setEnabled(v => !v)}>Toggle</button>
        <button id="theme" onClick={() => setTheme({background:'#ffffff',foreground:'#111111',blue:'#abcdef'})}>Theme</button>
        <button id="toggle-input" onClick={() => setShowInput(v => !v)}>Input preview</button>
        <button id="history" onClick={() => setHistoryOpen(v => !v)}>Recent commands</button>
        <div id="pane" style={{position:'relative',width:'100%',height:360}}>
          <div ref={container} style={{width:'100%',height:'100%'}} />
          <div id="mobile-overlay" style={{position:'absolute',inset:0,zIndex:4,pointerEvents:'none'}} />
          <TerminalScrollbar xtermRef={xtermRef} fitNowRef={fitNowRef} sessionId="test" historyKey="test"
            enabled={enabled} showInputOnScroll={showInput} active ready={ready}
            tmuxBacked={false}
            theme={theme}
            t={k=>copy[k]||k} />
        </div>
        {historyOpen && <HistoryPanel terminalKey="test" onPick={text=>{window.pickedCommand=text;}} />}
        </>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:900,height:500}});
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    await page.route('http://terminal-preview.test/', route => route.fulfill({contentType:'text/html',
      body:'<style>body{margin:0}.xterm{width:100%!important;height:100%!important;overflow:hidden!important}.xterm-scrollable-element{height:100%!important}</style><div id="root"></div>'}));
    await page.goto('http://terminal-preview.test/');
    await page.addStyleTag({path:path.join(root,'node_modules/@xterm/xterm/css/xterm.css')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const cwdPath = page.getByText('~/app/project/with/a/very/deep/directory/that/is/truncated', {exact:true});
    await cwdPath.hover();
    const cwdTooltip = page.getByRole('tooltip');
    await cwdTooltip.waitFor();
    await cwdTooltip.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    assert.equal(await cwdTooltip.innerText(), '/home/ubuntu/app/project/with/a/very/deep/directory/that/is/truncated');
    const tooltipBox = await cwdTooltip.boundingBox();
    assert.ok(tooltipBox.x >= 0 && tooltipBox.x + tooltipBox.width <= 900,
      'Full-path tooltip is clamped inside the viewport');
    await page.screenshot({path:'/tmp/terminal-cwd-tooltip-'+engine.name()+'.png'});
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await cwdTooltip.evaluate((element) => getComputedStyle(element).animationName), 'none',
      'Path tooltip respects reduced motion');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.mouse.move(600, 20);
    await page.waitForFunction(() => window.term?.buffer.active.baseY > 100);
    const bar = page.getByRole('scrollbar');
    assert.equal(await bar.count(), 0, 'Scrollbar stays hidden until the user opts in');
    await page.locator('#pane').screenshot({path:'/tmp/terminal-scrollbar-default-off-'+engine.name()+'.png'});
    await page.locator('#toggle').click();
    await bar.waitFor();
    const captureWidths = async (state) => {
      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({width, height:500});
        await page.evaluate(() => window.fitTerminal());
        await page.screenshot({path:'/tmp/terminal-scrollbar-'+state+'-'+width+'-'+engine.name()+'.png'});
      }
      await page.setViewportSize({width:900,height:500});
      await page.evaluate(() => window.fitTerminal());
    };
    await captureWidths('dark');
    const originalBar = await bar.elementHandle();
    assert.ok(await bar.evaluate((element) => element.getBoundingClientRect().width >= 24),
      'Scrollbar exposes a mobile-sized pointer target');
    const rail = page.locator('[role="scrollbar"] > [aria-hidden="true"]');
    assert.equal((await rail.boundingBox()).width, 8, 'Visible rail is exactly 8px');
    const thumb = rail.locator(':scope > div');
    assert.equal((await thumb.boundingBox()).width, 4, 'Thumb is exactly 4px');
    assert.equal(await rail.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)',
      'Rail floats transparently over terminal content');
    assert.equal(await thumb.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(244, 244, 244, 0.35)',
      'Idle thumb is a translucent themed overlay');
    assert.equal(await bar.evaluate((element) => getComputedStyle(element).cursor), 'grab');
    await page.locator('#pane').screenshot({path:'/tmp/terminal-scrollbar-hover-rest-'+engine.name()+'.png',
      animations:'allow'});
    await bar.hover();
    assert.equal(await thumb.evaluate((element) => element.style.transform), 'scaleX(1.5)');
    assert.equal(await thumb.evaluate((element) => element.style.background), 'rgba(244, 244, 244, 0.55)');
    await thumb.evaluate((element) => element.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
    }));
    await page.locator('#pane').screenshot({path:'/tmp/terminal-scrollbar-hover-mid-'+engine.name()+'.png',
      animations:'allow'});
    await thumb.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()));
    assert.equal(Math.round((await thumb.boundingBox()).width), 6, 'Hover expands the visible thumb to 6px');
    await page.locator('#pane').screenshot({path:'/tmp/terminal-scrollbar-hover-settled-'+engine.name()+'.png',
      animations:'allow'});
    await page.mouse.move(400, 20);
    await thumb.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    assert.equal(await thumb.evaluate((element) => element.style.transform), 'scaleX(1)');
    assert.equal(await page.evaluate(() => window.term.element.style.paddingRight), '0px',
      'Scrollbar reserves no terminal width');
    await page.locator('#theme').click();
    assert.equal(await bar.evaluate((element, original) => element === original, originalBar), true,
      'Theme updates the existing scrollbar without remounting it');
    assert.equal(await page.locator('[role="scrollbar"] > [aria-hidden="true"]').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    await thumb.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    assert.equal(await thumb.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(17, 17, 17, 0.35)');
    await captureWidths('light');
    const box = await bar.boundingBox();
    const thumbBox = await thumb.boundingBox();
    const callsBeforeGrab = await page.evaluate(() => window.scrollCalls.length);
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.tl-scrollbar-thumb')?.style.transform === 'scaleX(2)');
    await thumb.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    assert.equal(Math.round((await thumb.boundingBox()).width), 8, 'Drag expands the visible thumb to 8px');
    assert.equal(await bar.evaluate((element) => getComputedStyle(element).cursor), 'grabbing');
    assert.equal(await page.evaluate(() => window.scrollCalls.length), callsBeforeGrab,
      'Grabbing the thumb does not send a redundant seek');
    await page.locator('#pane').screenshot({path:'/tmp/terminal-scrollbar-drag-'+engine.name()+'.png'});
    await page.mouse.move(box.x + box.width/2, box.y + 10, {steps:10});
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.ok(await page.evaluate(() => window.term.buffer.active.viewportY < 20),
      'Custom scrollbar reaches its target within one frame even when smooth scrolling is enabled');
    assert.equal(await page.evaluate(() => window.term.options.smoothScrollDuration), 100,
      'Direct seeking restores the user smooth-scroll preference');
    await page.mouse.up();
    assert.ok(await page.evaluate(() => window.term.buffer.active.viewportY < 20), 'Drag reaches history');
    await bar.focus();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => window.term.buffer.active.viewportY), await page.evaluate(() => window.term.buffer.active.baseY));
    const narrow = await page.evaluate(() => window.term.cols);
    await page.locator('#toggle').click();
    assert.equal(await bar.count(),0);
    const hidden = await page.evaluate(() => window.term.cols);
    assert.ok(hidden >= narrow, 'Hiding never narrows the terminal (overlay reserves no gutter)');
    await page.locator('#toggle').click();
    const shown = await page.evaluate(() => window.term.cols);
    assert.equal(await page.evaluate(() => window.term.element.style.paddingRight), '0px',
      'Re-enabling keeps the overlay contract');
    assert.ok(Math.abs(shown - hidden) <= 1, 'Toggling does not reflow the terminal');
    await page.setViewportSize({width:390,height:500});
    await page.evaluate(() => {
      document.querySelector('#mobile-overlay').style.pointerEvents = 'auto';
      window.dispatchEvent(new Event('resize'));
    });
    const mobile = await bar.boundingBox();
    assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y).getAttribute('role'),
      {x:mobile.x+8,y:mobile.y+50}), 'scrollbar', 'Mobile overlay does not block scrollbar');
    assert.deepEqual(await page.evaluate(() => window.chunks), [], 'Scrolling never types into the shell');
    const preview = page.getByRole('region', {name:'현재 구간의 질문'});
    assert.equal(await preview.count(), 0, 'Hidden at the bottom');
    const goToAnswer = async (letter) => {
      await page.evaluate(letter => {
        const buffer = window.term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.getLine(i)?.translateToString(true).startsWith('Answer '+letter+' 10')) {
            window.term.scrollToLine(i); return;
          }
        }
        throw new Error('Missing answer '+letter);
      }, letter);
      await preview.waitFor();
      await page.waitForFunction(letter => document.querySelector('[role="region"]')?.textContent.includes('질문 '+letter), letter);
      assert.ok((await preview.innerText()).includes('질문 '+letter));
    };
    for (const letter of ['A','B','C','A']) await goToAnswer(letter);
    assert.equal(await preview.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(60, 64, 72)');
    assert.equal(await preview.evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)',
      'Preview text stays readable when a light theme shows a retained dark ANSI background');
    const expand = preview.getByRole('button', {name:'질문 펼치기'});
    await expand.click();
    const collapse = preview.getByRole('button', {name:'질문 접기'});
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true', 'Question expands independently');
    await collapse.click();
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await preview.evaluate(el => getComputedStyle(el).animationName), 'none',
      'Question preview respects reduced motion');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const beforeJump = await page.evaluate(() => window.term.buffer.active.viewportY);
    await preview.locator('button[title="질문 위치로 이동"]').click();
    await preview.waitFor({state:'hidden'});
    assert.ok(await page.evaluate(() => window.term.buffer.active.viewportY) < beforeJump);
    assert.ok(await page.evaluate(() => {
      const b = window.term.buffer.active;
      return b.getLine(b.viewportY).translateToString(true).startsWith('› 질문 A');
    }), 'Click reveals the original question at the viewport top');
    await goToAnswer('A');
    assert.equal(await preview.evaluate(el => el.style.right), '0px');
    const paneBox = await page.locator('#pane').boundingBox();
    const previewBox = await preview.boundingBox();
    assert.equal(previewBox.x, paneBox.x, 'Preview starts at the pane edge');
    assert.equal(previewBox.width, paneBox.width, 'Preview background spans the full pane width');
    assert.equal(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.getAttribute('role'),
      {x:paneBox.x+paneBox.width-8,y:previewBox.y+8}), 'scrollbar',
      'Scrollbar remains above the full-width preview');
    assert.equal(await preview.evaluate(el => el.style.maxWidth), '');
    await page.locator('#pane').screenshot({path:'/tmp/terminal-input-context-'+engine.name()+'.png'});
    await preview.getByRole('button', {name:'닫기'}).click();
    await preview.waitFor({state:'hidden'});
    assert.equal(await preview.count(), 0, 'Dismiss hides the card until the prompt returns');
    await goToAnswer('C');
    await page.locator('#toggle').click();
    assert.equal(await bar.count(),0);
    await goToAnswer('B');
    await page.locator('#toggle-input').click();
    await preview.waitFor({state:'hidden'});
    await page.locator('#toggle-input').click();
    await preview.waitFor();
    assert.ok((await preview.innerText()).includes('질문 B'), 'No new submission needed after remount');
    await page.evaluate(() => window.saveHistory('질문   B'));
    await page.waitForFunction(() => document.querySelector('[role="region"]')?.textContent.includes('질문   B'));
    await page.evaluate(() => window.term.scrollToBottom());
    await preview.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(() => window.chunks), [], 'Context detection never types into the shell');
    await page.evaluate(() => { window.term.input('새로 보낸 한글 질문', true); window.term.input('\r', true); });
    await page.locator('#history').click();
    assert.equal(await page.getByRole('button', {name:'새로 보낸 한글 질문', exact:true}).count(), 0,
      'Raw terminal input is never persisted');
    await page.evaluate(() => window.saveHistory('명시적으로 저장한 한글 질문'));
    const saved = page.getByRole('button', {name:'명시적으로 저장한 한글 질문', exact:true});
    await saved.waitFor();
    await saved.click();
    assert.equal(await page.evaluate(() => window.pickedCommand), '명시적으로 저장한 한글 질문');
    assert.deepEqual(errors, []);
    console.log(engine.name()+': path tooltip, scrollbar, A/B/C context, background and shared Recent commands passed');
  } finally { await browser.close(); }
}
