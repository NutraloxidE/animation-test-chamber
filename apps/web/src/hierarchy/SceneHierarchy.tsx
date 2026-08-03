/**
 * The scene tree — the actual world, on the left, where a scene tree goes.
 *
 * This renders the *staged world*: the same document the viewport runs and the
 * same one the typed commands edit. It is not a second model built for the
 * panel. A project with no explicit world still resolves through the
 * synthesized one-instance world, so the legacy focused chamber is a view over
 * a world here too rather than a parallel tree with its own rules.
 *
 * Attachment rows are derived projections of the project's declared equipment
 * slots for one instance. They are not canonical scene nodes and adding them
 * changed no schema: a deeper-looking tree is not worth a migration.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useChamber } from '../store.ts';
import {
  sameSelection,
  sceneNodeKey,
  type SceneSelection,
} from '../selection/scene-selection.ts';
import { HierarchyRow } from './HierarchyRow.tsx';

interface FlatNode {
  selection: SceneSelection;
  depth: number;
  label: string;
  icon: string;
  badges: string[];
  inactive: boolean;
  /** Undefined for leaves. */
  expandable: boolean;
  testId: string;
}

export function SceneHierarchy() {
  const world = useChamber((state) => state.stagedWorld);
  const selection = useChamber((state) => state.sceneSelection);
  const selectScene = useChamber((state) => state.selectScene);
  const worldDirty = useChamber((state) => state.worldDirty);
  const terrainPresetId = useChamber((state) => state.terrainPresetId);
  const equipmentSlots = useChamber((state) => state.canonicalProject.equipment);
  const loadoutOf = useChamber((state) => state.loadoutOf);

  /**
   * Expansion is keyed by stable node identity, not by array position, and it
   * is *this component's* state rather than the store's — collapsing a branch
   * is not something the rest of the application needs to know about. Keying
   * by identity is what keeps a 120ms observation refresh from resetting every
   * triangle the user opened.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isExpanded = useCallback(
    (selectionKey: string) => collapsed[selectionKey] !== true,
    [collapsed],
  );
  const toggle = useCallback((selectionKey: string) => {
    setCollapsed((current) => ({ ...current, [selectionKey]: current[selectionKey] !== true }));
  }, []);

  const rows = useMemo<FlatNode[]>(() => {
    const worldKey = sceneNodeKey({ kind: 'world' });
    const nodes: FlatNode[] = [
      {
        selection: { kind: 'world' },
        depth: 0,
        label: world.displayName,
        icon: '◇',
        badges: worldDirty ? ['Staged'] : [],
        inactive: false,
        expandable: true,
        testId: 'scene-node-world',
      },
    ];
    if (!isExpanded(worldKey)) return nodes;

    for (const instance of world.instances) {
      const instanceSelection: SceneSelection = { kind: 'instance', instanceId: instance.id };
      const instanceKey = sceneNodeKey(instanceSelection);
      const loadout = loadoutOf(instance.id);

      // At most two badges, and the ones that change what the user is looking
      // at come first: a row is a summary, not a property sheet in miniature.
      const badges: string[] = [];
      if (!instance.enabled) badges.push('Disabled');
      if (instance.id === world.focusedInstanceId) badges.push('Focused');
      if (badges.length < 2 && instance.id === world.cameraTargetInstanceId) badges.push('Camera');
      if (badges.length < 2 && loadout?.weaponMode.override) {
        badges.push(loadout.weaponMode.effective);
      }

      nodes.push({
        selection: instanceSelection,
        depth: 1,
        label: instance.displayName,
        icon: '☗',
        badges,
        inactive: !instance.enabled,
        expandable: equipmentSlots.length > 0,
        testId: `scene-node-instance-${instance.id}`,
      });

      if (!isExpanded(instanceKey)) continue;
      for (const slot of equipmentSlots) {
        const state = loadout?.equipment.find((entry) => entry.slotId === slot.id);
        const effective = state?.effective ?? slot.defaultEquipped;
        nodes.push({
          selection: { kind: 'attachment', instanceId: instance.id, slotId: slot.id },
          depth: 2,
          label: slot.label,
          icon: '▣',
          // "Override" earns its place over "Equipped": whether this instance
          // disagrees with the shared definition is the thing you cannot work
          // out by looking at the viewport.
          badges: state?.override === null ? [] : ['Override'],
          inactive: !effective,
          expandable: false,
          testId: `scene-node-attachment-${instance.id}-${slot.id}`,
        });
      }
    }

    nodes.push({
      selection: { kind: 'terrain' },
      depth: 1,
      label: `Terrain · ${terrainPresetId}`,
      icon: '▦',
      badges: [],
      inactive: false,
      expandable: false,
      testId: 'scene-node-terrain',
    });
    nodes.push({
      selection: { kind: 'camera' },
      depth: 1,
      label: 'Camera',
      icon: '◉',
      badges: [],
      inactive: false,
      expandable: false,
      testId: 'scene-node-camera',
    });
    return nodes;
  }, [world, worldDirty, terrainPresetId, equipmentSlots, loadoutOf, isExpanded]);

  const rowElements = useRef<(HTMLDivElement | null)[]>([]);
  const registerRow = useCallback((index: number, element: HTMLDivElement | null) => {
    rowElements.current[index] = element;
  }, []);

  const selectedIndex = rows.findIndex((row) => sameSelection(row.selection, selection));

  const focusRow = useCallback((index: number) => {
    rowElements.current[index]?.focus();
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = selectedIndex === -1 ? 0 : selectedIndex;
      const next = Math.min(rows.length - 1, Math.max(0, from + delta));
      selectScene(rows[next]!.selection);
      focusRow(next);
    },
    [rows, selectedIndex, selectScene, focusRow],
  );

  /** Standard tree keys. Arrow Left collapses, or climbs to the parent. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = rows[selectedIndex];
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'ArrowRight': {
        if (!current) return;
        event.preventDefault();
        const key = sceneNodeKey(current.selection);
        if (current.expandable && !isExpanded(key)) toggle(key);
        else move(1);
        break;
      }
      case 'ArrowLeft': {
        if (!current) return;
        event.preventDefault();
        const key = sceneNodeKey(current.selection);
        if (current.expandable && isExpanded(key)) {
          toggle(key);
          return;
        }
        // Climb: the nearest row above with a smaller depth is the parent.
        for (let index = selectedIndex - 1; index >= 0; index -= 1) {
          if (rows[index]!.depth < current.depth) {
            selectScene(rows[index]!.selection);
            focusRow(index);
            return;
          }
        }
        break;
      }
      case 'Enter':
      case ' ':
        if (!current) return;
        event.preventDefault();
        selectScene(current.selection);
        break;
      default:
        break;
    }
  };

  // Sibling counts for aria-setsize/posinset, computed per depth run.
  const siblings = rows.map((row, index) => {
    const peers = rows.filter((other, otherIndex) => {
      if (other.depth !== row.depth) return false;
      // Same parent means no shallower row sits between the two.
      const [low, high] = index < otherIndex ? [index, otherIndex] : [otherIndex, index];
      return !rows.slice(low + 1, high).some((between) => between.depth < row.depth);
    });
    return { setSize: peers.length, positionInSet: peers.indexOf(row) + 1 };
  });

  return (
    <div className="hierarchy" data-testid="hierarchy">
      <header className="hierarchy__header">Hierarchy</header>
      <div
        className="hierarchy__tree"
        role="tree"
        aria-label="Scene hierarchy"
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => {
          const key = sceneNodeKey(row.selection);
          return (
            <HierarchyRow
              key={key}
              depth={row.depth}
              label={row.label}
              icon={row.icon}
              badges={row.badges}
              inactive={row.inactive}
              selected={index === selectedIndex}
              onSelect={() => selectScene(row.selection)}
              {...(row.expandable
                ? { expanded: isExpanded(key), onToggleExpanded: () => toggle(key) }
                : {})}
              testId={row.testId}
              rowIndex={index}
              setSize={siblings[index]!.setSize}
              positionInSet={siblings[index]!.positionInSet}
              registerRow={registerRow}
            />
          );
        })}
      </div>
    </div>
  );
}
