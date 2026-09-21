import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { createSubmittedInputCapture } from './submittedInput';
import { buildThemeUI, readableForeground, withAlpha } from '../../styles/themeUI';
import tokens from '../../styles/tokens';
import { cellBackground } from './terminalPromptContext';
import './terminalStyles';

export default function TerminalInputPreview({ xtermRef, inputPreviewRef, ready,
  active, scrolled, scrollbar, theme, t, sessionId, context, onJump }) {
  const text = context?.text || '';
  const contextKey = `${String(context?.offset ?? '')}\u0000${text}`;
  const [dismissedKey, setDismissedKey] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [inputBackground, setInputBackground] = useState(null);
  const [toggleFocused, setToggleFocused] = useState(false);
  const [dismissFocused, setDismissFocused] = useState(false);
  const previewRef = useRef(null);
  const themeUi = buildThemeUI(theme);

  useEffect(() => {
    setInputBackground(null);
    const term = xtermRef.current;
    if (!ready || !term) return;
    const capture = createSubmittedInputCapture(term, () => {
      // Match the submitted prompt's fill (including terminal RGB/ANSI colors).
      // Plain shells use the raised theme surface instead of the terminal floor.
      const buffer = term.buffer.active;
      setInputBackground(cellBackground(term, buffer.baseY + buffer.cursorY, buffer.cursorX));
    });
    if (inputPreviewRef) inputPreviewRef.current = capture;
    const subscription = term.onData(capture);
    return () => {
      subscription.dispose();
      if (inputPreviewRef?.current === capture) inputPreviewRef.current = null;
    };
  }, [ready, sessionId, xtermRef, inputPreviewRef]);

  useEffect(() => {
    setDismissedKey(null);
    setExpanded(false);
  }, [contextKey]);
  useEffect(() => {
    if (!scrolled) {
      setDismissedKey(null);
      setExpanded(false);
    }
  }, [scrolled]);

  const visible = ready && active && scrolled && Boolean(text) && dismissedKey !== contextKey;
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const terminal = xtermRef.current?.element;
    if (!visible || !preview || !terminal) return undefined;
    const previousClipPath = terminal.style.clipPath;
    const previousWebkitClipPath = terminal.style.webkitClipPath;
    const clipTerminal = () => {
      const inset = `inset(${Math.ceil(preview.getBoundingClientRect().height)}px 0 0 0)`;
      terminal.style.clipPath = inset;
      terminal.style.webkitClipPath = inset;
    };
    clipTerminal();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clipTerminal);
    observer?.observe(preview);
    return () => {
      observer?.disconnect();
      terminal.style.clipPath = previousClipPath;
      terminal.style.webkitClipPath = previousWebkitClipPath;
    };
  }, [visible, contextKey, xtermRef]);

  if (!visible) return null;
  const previewBackground = context?.background || inputBackground || themeUi.surface0;
  const previewForeground = readableForeground(previewBackground, theme.foreground);
  const canJump = Number.isFinite(context?.offset);
  const scrollbarInset = scrollbar ? tokens.space['6'] : '0px';
  const jump = () => {
    // Selecting text for copying must not navigate the terminal.
    if (!window.getSelection()?.toString() && canJump) onJump?.();
  };
  return (
    <div ref={previewRef} key={contextKey} className="tl-input-preview" role="region" aria-label={t('terminalContextInput')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); jump(); }}
      style={{ position: 'absolute', top: 0, left: 0, right: 0,
        zIndex: tokens.z.terminalInputPreview, color: previewForeground,
        background: previewBackground,
        border: 0, borderBottom: `1px solid ${withAlpha(previewForeground, 0.18)}`,
        borderRadius: `0 0 ${tokens.radius.sm} ${tokens.radius.sm}`, boxShadow: tokens.shadow.sm,
        boxSizing: 'border-box', pointerEvents: 'auto',
        padding: `${tokens.space['1']} ${tokens.space['2.5']}`,
        fontSize: tokens.fontSize['12'], lineHeight: tokens.lineHeight.normal,
        animation: `tl-preview-in ${tokens.motion.normal}`,
        touchAction: 'pan-y', userSelect: 'text' }}>
      <button type="button" disabled={!canJump} title={t('terminalInputJump')}
        onClick={(event) => { event.stopPropagation(); jump(); }}
        style={{ display: 'flex',
          alignItems: expanded ? 'flex-start' : 'center', gap: tokens.space['2'],
          width: `calc(100% - ${scrollbarInset})`, minWidth: 0, textAlign: 'left', color: 'inherit',
          background: 'none', border: 0, padding: 0, font: 'inherit', userSelect: 'text',
          cursor: canJump ? 'pointer' : 'default', pointerEvents: 'auto' }}>
        <span style={{ flexShrink: 0 }}>{t('terminalContextInput')}</span>
        <span style={{ flex: 1, minWidth: 0,
          whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
          overflowWrap: expanded ? 'anywhere' : 'normal',
          overflowY: expanded ? 'auto' : 'hidden',
          textOverflow: expanded ? 'clip' : 'ellipsis',
          maxHeight: expanded ? 'min(35vh, 180px)' : 'none',
          display: 'block',
          paddingRight: `calc(${tokens.space['12']} + ${tokens.space['2']})` }}>{text}</span>
      </button>
      <button type="button" aria-expanded={expanded}
        aria-label={t(expanded ? 'terminalInputCollapse' : 'terminalInputExpand')}
        title={t(expanded ? 'terminalInputCollapse' : 'terminalInputExpand')}
        onFocus={() => setToggleFocused(true)} onBlur={() => setToggleFocused(false)}
        onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
        style={{ position: 'absolute', top: expanded ? tokens.space['1'] : '50%',
          right: `calc(${scrollbarInset} + ${tokens.space['6']} + ${tokens.space['1']})`,
          transform: expanded ? 'none' : 'translateY(-50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minWidth: tokens.space['6'], minHeight: tokens.space['6'],
          background: 'none', border: 0, borderRadius: tokens.radius.sm,
          padding: 0, color: previewForeground, cursor: 'pointer', pointerEvents: 'auto',
          boxShadow: toggleFocused
            ? `0 0 0 ${tokens.space['0.5']} ${previewForeground}`
            : tokens.shadow.none }}>
        {expanded ? <ChevronUp size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
      </button>
      <button type="button" aria-label={t('terminalInputDismiss')}
        onFocus={() => setDismissFocused(true)} onBlur={() => setDismissFocused(false)}
        onClick={(event) => { event.stopPropagation(); setDismissedKey(contextKey); }}
        style={{ position: 'absolute', top: expanded ? tokens.space['1'] : '50%',
          right: `calc(${scrollbarInset} + ${tokens.space['1']})`,
          transform: expanded ? 'none' : 'translateY(-50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minWidth: tokens.space['6'], minHeight: tokens.space['6'],
          background: 'none', border: 0, borderRadius: tokens.radius.sm,
          padding: 0, color: previewForeground, cursor: 'pointer', pointerEvents: 'auto',
          boxShadow: dismissFocused
            ? `0 0 0 ${tokens.space['0.5']} ${previewForeground}`
            : tokens.shadow.none }}>
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
