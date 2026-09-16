import DemoTerminal from './DemoTerminal';
import { DEMO_SCRIPTS } from './demoData';
import SubTabBar from '../components/panegrid/SubTabBar';
import { tokens } from '../styles/tokens';

const { color } = tokens;

/**
 * Recursively renders a real splitTree (utils/splitTree.js shape) so the demo
 * shows genuine split-pane layouts — same tree format the production app
 * builds via splitLeaf(), not a hand-drawn mockup.
 */
const DemoPaneTree = ({ node, panesById, activePaneId, onSelectPane }) => {
  if (!node) return null;

  if (node.type === 'pane') {
    const pane = panesById[node.paneId];
    if (!pane) return null;
    const isActive = node.paneId === activePaneId;
    return (
      <div
        onMouseDown={() => onSelectPane(node.paneId)}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          border: `1px solid ${isActive ? color.accent : 'var(--ui-border)'}`,
          borderRadius: '4px',
          overflow: 'hidden',
          boxSizing: 'border-box',
          transition: 'border-color 120ms',
        }}
      >
        <DemoTerminal script={DEMO_SCRIPTS[pane.scriptId]} isActive={isActive} />
      </div>
    );
  }

  // node.type === 'split'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: node.direction === 'column' ? 'column' : 'row',
        width: '100%',
        height: '100%',
        gap: '4px',
      }}
    >
      {node.children.map((child, i) => (
        <div key={i} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <DemoPaneTree
            node={child}
            panesById={panesById}
            activePaneId={activePaneId}
            onSelectPane={onSelectPane}
          />
        </div>
      ))}
    </div>
  );
};

const DemoPaneGrid = ({
  node, panes, panesById, activePaneId, onSelectPane,
  isMobile, hosts, settings, tabColorIndex,
}) => {
  if (isMobile && panes.length > 1) {
    const activePane = panesById[activePaneId] || panes[0];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
        <SubTabBar
          panes={panes}
          activePaneId={activePane.id}
          hosts={hosts}
          settings={settings}
          tabColorIndex={tabColorIndex}
          onSelect={onSelectPane}
          onClose={() => {}}
        />
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {panes.map((pane) => {
            const isActive = pane.id === activePane.id;
            return (
              <div
                key={pane.id}
                {...(!isActive ? { inert: '' } : {})}
                style={{
                  position: 'absolute', inset: 0,
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                }}
              >
                <DemoTerminal script={DEMO_SCRIPTS[pane.scriptId]} isActive={isActive} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <DemoPaneTree
      node={node}
      panesById={panesById}
      activePaneId={activePaneId}
      onSelectPane={onSelectPane}
    />
  );
};

export default DemoPaneGrid;
