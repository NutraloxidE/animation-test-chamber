/**
 * One row of the scene tree.
 *
 * A row answers four questions — what is this, is it selected, is it
 * enabled, does it have children — and deliberately cannot answer a fifth.
 * There is no `children` prop for arbitrary controls and no escape hatch for
 * a `<select>`: the previous tree grew inline character, weapon and equipment
 * pickers one reasonable-looking commit at a time, until the left panel was a
 * settings form wearing indentation. Making the row type unable to hold a
 * property editor is what stops that from happening a second time.
 */
import type { ReactNode } from 'react';

export interface HierarchyRowProps {
  depth: number;
  label: string;
  /** Single glyph. Decorative — the label carries the meaning. */
  icon: string;
  selected: boolean;
  onSelect: () => void;
  /** Undefined means the row is a leaf and renders no triangle. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Concise summaries, never editors. Two is the practical maximum. */
  badges?: string[];
  /** Struck through and dimmed, for a disabled instance or unequipped slot. */
  inactive?: boolean;
  testId: string;
  /** Tree semantics for assistive technology and the keyboard handler. */
  rowIndex: number;
  setSize: number;
  positionInSet: number;
  registerRow?: (index: number, element: HTMLDivElement | null) => void;
}

export function HierarchyRow({
  depth,
  label,
  icon,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
  badges = [],
  inactive = false,
  testId,
  rowIndex,
  setSize,
  positionInSet,
  registerRow,
}: HierarchyRowProps): ReactNode {
  const className = [
    'hierarchy__row',
    selected ? 'is-selected' : '',
    inactive ? 'is-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={(element) => registerRow?.(rowIndex, element)}
      className={className}
      style={{ paddingLeft: 6 + depth * 14 }}
      role="treeitem"
      aria-selected={selected}
      aria-level={depth + 1}
      aria-setsize={setSize}
      aria-posinset={positionInSet}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      // Roving tabindex: one stop for the whole tree, then arrow keys inside
      // it. Thirty tab stops to reach the terrain row is not navigation.
      tabIndex={selected ? 0 : -1}
      data-testid={testId}
      data-selected={selected}
      onClick={onSelect}
    >
      {onToggleExpanded ? (
        <button
          type="button"
          className="hierarchy__disclosure"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          data-testid={`${testId}-disclosure`}
          onClick={(event) => {
            // Without this the disclosure would also select the row, making
            // "collapse this parent" quietly move the inspector.
            event.stopPropagation();
            onToggleExpanded();
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="hierarchy__disclosure hierarchy__disclosure--leaf" />
      )}
      <span className="hierarchy__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="hierarchy__label">{label}</span>
      {badges.slice(0, 2).map((badge) => (
        <span key={badge} className="hierarchy__badge">
          {badge}
        </span>
      ))}
    </div>
  );
}
