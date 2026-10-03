// Real xterm touch/focus checks in mobile Chromium and WebKit. No live sessions.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React, {useEffect, useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import createXtermInstance from './src/components/terminal/createXtermInstance';
    import ensureStyles from './src/components/terminal/xtermGlobalCss';
    import attachTerminalInteractions from './src/components/terminal/attachTerminalInteractions';
    import setTerminalReadOnly from './src/components/terminal/setTerminalReadOnly';
    import MobileToolbar from './src/components/MobileToolbar';
    import useMobileViewMode from './src/hooks/useMobileViewMode';
    function App() {
      const container = useRef(); const overlay = useRef(); const termRef = useRef();
      const [viewOnly, setViewOnly] = useMobileViewMode();
      const locked = useRef(viewOnly); locked.current = viewOnly;
      const [text, setText] = useState('');
      useEffect(() => {
        ensureStyles();
        const {term, fitAddon} = createXtermInstance({container:container.current,
          settings:{fontSize:13,predictiveEcho:false},theme:{background:'#11111b',foreground:'#eeeeee'}});
        window.term = termRef.current = term;
        window.input = []; window.pointerInput = []; window.fitTerminal = () => fitAddon.fit();
        fitAddon.fit();
        setTerminalReadOnly(term, locked.current);
        term.onData(data => { if (!locked.current) window.input.push(data); });
        const interactions = attachTerminalInteractions({term,container:container.current,overlay:overlay.current,
          input:{push:data=>window.pointerInput.push(data)},getSocket:()=>({readyState:1}),
          isMobile:()=>true,isReadOnly:()=>locked.current,sessionId:'smoke',
          logger:console,setContextMenu:()=>{},setCopyFlash:()=>{},setImagePasteState:()=>{}});
        term.write(Array.from({length:150},(_,i)=>'출력 내용 '+i+' — 보기 모드에서 안전하게 읽기\\r\\n').join(''));
        return () => { interactions.detach(); term.dispose(); };
      }, []);
      useEffect(() => { setTerminalReadOnly(termRef.current, viewOnly); }, [viewOnly]);
      return <main style={{background:'#11111b',color:'#eee',height:'100dvh',display:'flex',flexDirection:'column'}}>
        <div style={{padding:12,fontFamily:'sans-serif'}}>Terminal List · 모바일 보기 모드</div>
        <div id="pane" style={{position:'relative',flex:1,minHeight:0}}>
          <div ref={container} style={{height:'100%',width:'100%'}} />
          <div ref={overlay} id="touch-surface" style={{position:'absolute',inset:0,zIndex:4,touchAction:'none'}} />
        </div>
        <MobileToolbar language="ko" viewOnly={viewOnly} onToggleViewOnly={()=>setViewOnly(!viewOnly)}
          onSendKey={data=>{if(!locked.current)termRef.current.input(data,true);}}
          onAction={action=>{if(action==='viewAsText')setText('출력 내용: 읽기와 복사 가능');}} />
        {text && <div role="dialog">{text}</div>}
      </main>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://terminal-view.test/', route => route.fulfill({contentType:'text/html',
      body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.xterm{width:100%!important;height:100%!important;overflow:hidden!important}.xterm-scrollable-element{height:100%!important}</style><div id="root"></div>'}));
    const boot = async () => {
      await page.goto('http://terminal-view.test/');
      await page.addStyleTag({path:path.join(root,'node_modules/@xterm/xterm/css/xterm.css')});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.waitForFunction(() => window.term?.buffer.active.baseY > 90);
    };
    await boot();
    await page.getByRole('button', {name:'입력 모드로 전환'}).waitFor();
    assert.equal(await page.locator('textarea').evaluate(el => el.readOnly && el.inputMode === 'none'), true);
    await page.locator('#touch-surface').tap();
    assert.equal(await page.evaluate(() => document.activeElement === window.term.textarea), false);
    await page.keyboard.type('unwanted');
    assert.deepEqual(await page.evaluate(() => window.input), []);
    const before = await page.evaluate(() => window.term.buffer.active.viewportY);
    await page.evaluate(() => {
      const el = document.getElementById('touch-surface');
      const touch = (type,y) => {
        const event = new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperty(event,'touches',{value:type==='touchend'?[]:[{clientX:80,clientY:y}]});
        el.dispatchEvent(event);
      };
      touch('touchstart',100); touch('touchmove',220); touch('touchend',220);
    });
    await page.waitForFunction(before => window.term.buffer.active.viewportY < before, before);
    assert.deepEqual(await page.evaluate(() => window.pointerInput), []);
    await page.getByRole('button',{name:'텍스트로 보기'}).tap();
    assert.match(await page.getByRole('dialog').innerText(), /읽기와 복사/);
    await page.getByRole('button',{name:'입력 모드로 전환'}).tap();
    await page.waitForFunction(() => !window.term.options.disableStdin);
    await page.locator('#touch-surface').tap();
    assert.equal(await page.evaluate(() => document.activeElement === window.term.textarea), true);
    await page.keyboard.type('hello');
    assert.equal(await page.evaluate(() => window.input.join('')), 'hello');
    await boot();
    await page.getByRole('button',{name:'보기 모드로 전환'}).waitFor();
    await page.getByRole('button',{name:'보기 모드로 전환'}).tap();
    await page.waitForFunction(() => window.term.options.disableStdin);
    assert.equal(await page.evaluate(() => document.activeElement === window.term.textarea), false);
    await boot();
    await page.getByRole('button',{name:'입력 모드로 전환'}).waitFor();
    for (const width of [320,375,430]) {
      await page.setViewportSize({width,height:667});
      await page.evaluate(() => window.fitTerminal());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    }
    await page.screenshot({path:'/tmp/terminal-mobile-view-'+engine.name()+'.png'});
    assert.deepEqual(errors, []);
    console.log(engine.name()+': mobile view/input, scrolling, copy UI and persistence passed');
  } finally { await browser.close(); }
}
