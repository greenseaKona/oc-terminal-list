import { PlayCircle, Github } from 'lucide-react';
import { tokens } from '../styles/tokens';

const { color, font, fontWeight } = tokens;

const REPO_URL = 'https://github.com/jshsakura/oc-terminal-list';

/**
 * Compact footer explaining this is a scripted, read-only preview — not a live
 * server. It stays outside the production chrome so the demo mirrors the app layout.
 */
const DemoBanner = () => (
  <div
    className="iterm-demo-banner"
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '28px',
      padding: '4px 12px',
      background: `color-mix(in srgb, ${color.accent} 12%, var(--ui-mantle))`,
      borderBottom: '1px solid var(--ui-border)',
      fontFamily: font.sans,
      fontSize: '12px',
      color: color.subtext,
      flexShrink: 0,
      whiteSpace: 'nowrap',
    }}
  >
    <style>{`
      .iterm-demo-banner-mobile { display: none; }
      @media (max-width: 768px) {
        .iterm-demo-banner { min-height: 28px !important; padding: 3px 8px !important; gap: 6px !important; }
        .iterm-demo-banner-detail, .iterm-demo-banner-link { display: none !important; }
        .iterm-demo-banner-mobile { display: inline !important; overflow: hidden; text-overflow: ellipsis; }
      }
    `}</style>
    <PlayCircle size={14} strokeWidth={2} style={{ color: color.accent, flexShrink: 0 }} />
    <span style={{ fontWeight: fontWeight.semibold, color: color.text }}>Live Demo</span>
    <span className="iterm-demo-banner-detail">— scripted playback, sample hosts, no real shell or backend. Nothing you see here is a real server.</span>
    <span className="iterm-demo-banner-mobile">· scripted preview · no real shell</span>
    <a
      className="iterm-demo-banner-link"
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      style={{
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        color: color.accent,
        textDecoration: 'none',
        fontWeight: fontWeight.semibold,
        flexShrink: 0,
      }}
    >
      <Github size={13} strokeWidth={2} />
      Get it for your own server
    </a>
  </div>
);

export default DemoBanner;
