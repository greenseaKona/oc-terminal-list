import { useEffect, useState } from 'react';
import { createSubmittedInputCapture } from './submittedInput';
import { buildThemeUI } from '../../styles/themeUI';
import { cellBackground } from './terminalPromptContext';
import { pushCommand } from '../../utils/commandHistory';

export default function TerminalInputPreview({ xtermRef, inputPreviewRef, ready,
  active, scrolled, scrollbar, theme, t, sessionId, context, historyKey, onJump }) {
  const text = context?.text || '';
  const [expanded, setExpanded] = useState(false);
  const [inputBackground, setInputBackground] = useState(null);

  useEffect(() => {
    setExpanded(false);
    setInputBackground(null);
    const term = xtermRef.current;
    if (!ready || !term) return;
    const capture = createSubmittedInputCapture(term, (text) => {
      // Match the submitted prompt's fill (including terminal RGB/ANSI colors).
      // Plain shells use the raised theme surface instead of the terminal floor.
      const buffer = term.buffer.active;
      setInputBackground(cellBackground(term, buffer.baseY + buffer.cursorY, buffer.cursorX));
      // Persist complete submitted input through the existing Recent commands
      // rules. Do not save IME fragments or create another history database.
      if (historyKey && buffer.type === 'normal') {
        try { pushCommand(historyKey, text); } catch { /* History must not interrupt terminal input. */ }
      }
    });
    if (inputPreviewRef) inputPreviewRef.current = capture;
    const subscription = term.onData(capture);
    return () => {
      subscription.dispose();
      if (inputPreviewRef?.current === capture) inputPreviewRef.current = null;
    };
  }, [ready, sessionId, xtermRef, inputPreviewRef, historyKey]);

  useEffect(() => { setExpanded(false); }, [text]);

  if (!ready || !active || !scrolled || !text) return null;
  const canJump = Number.isFinite(context?.offset);
  const jump = () => {
    // Selecting text for copying must not navigate the terminal.
    if (!window.getSelection()?.toString() && canJump) onJump?.();
  };
  return (
    <div role="region" aria-label={t('terminalContextInput')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); jump(); }}
      style={{ position: 'absolute', top: 6, left: 8, right: scrollbar ? 24 : 8,
        zIndex: 7, color: theme.foreground, background: context?.background || inputBackground || buildThemeUI(theme).surface0,
        border: `1px solid color-mix(in srgb, ${theme.foreground} 28%, transparent)`,
        borderRadius: 6, boxShadow: '0 3px 12px #0004', padding: '7px 10px',
        fontSize: 12, lineHeight: 1.5, maxHeight: '35%', overflow: 'auto',
        touchAction: 'pan-y', userSelect: 'text' }}>
      <button type="button" disabled={!canJump} title={t('terminalInputJump')}
        onClick={(event) => { event.stopPropagation(); jump(); }}
        style={{ display: 'block', width: '100%', textAlign: 'left', color: 'inherit',
          background: 'none', border: 0, padding: 0, font: 'inherit', userSelect: 'text',
          cursor: canJump ? 'pointer' : 'default' }}>
        <span style={{ display: 'block', paddingRight: 65, opacity: 0.7 }}>{t('terminalContextInput')}</span>
        <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          display: expanded ? 'block' : '-webkit-box', WebkitBoxOrient: 'vertical',
          WebkitLineClamp: expanded ? 'unset' : 2, overflow: 'hidden' }}>{text}</span>
      </button>
      <button type="button" aria-expanded={expanded}
        onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
        style={{ position: 'absolute', top: 7, right: 10, background: 'none', border: 0,
          padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', opacity: 0.7 }}>
        {t(expanded ? 'terminalInputCollapse' : 'terminalInputExpand')}
      </button>
    </div>
  );
}
