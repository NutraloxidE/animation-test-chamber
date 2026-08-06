/**
 * Where a preserved panel gets its data.
 *
 * The fine-tuning panels are preservation targets: their blobs are still the
 * main-branch implementations, and the restoration is only allowed to move
 * their data source (§15). This module is that seam. A panel imports
 * `useChamber` and `useWeaponProject` from here instead of from `store.ts`, and
 * nothing else about it changes.
 *
 * It resolves in the only order that is safe during the migration:
 *
 *   inside an AnimationChamberProvider -> the subject-scoped facade
 *   outside one                        -> the legacy Character-bound store
 *
 * The fallback exists because both chambers are mounted at once while the
 * native workspace grows panel by panel, and a panel that threw outside a
 * provider would take the legacy chamber down with it. It is deliberately
 * *here* rather than in `animation-chamber/`, so the native directory never
 * imports the legacy store and the Phase U Repo Guard rule stays a flat
 * prohibition rather than a list of exceptions.
 *
 * This file is expected to disappear: once every caller reaches the workspace
 * through the native route, the panels import `useAnimationChamber` directly
 * and the legacy branch has no callers left.
 */
import { useMemo } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { resolveWeaponMode } from '@atc/animation-runtime';
import { useOptionalAnimationChamberFacade } from '../animation-chamber/AnimationChamberProvider.tsx';
import type { AnimationChamberSlice } from '../animation-chamber/useAnimationChamber.ts';
import { useChamber as legacyChamber } from '../store.ts';
import { WEAPON_MODES } from '../three/catalog.ts';

/**
 * The state a preserved panel selects from.
 *
 * The native facade's shape, not the legacy store's. A panel reaching for a
 * field only the Character-bound store has fails to compile here, which is how
 * this seam keeps the migration honest instead of merely convenient.
 */
export type PanelChamberSlice = AnimationChamberSlice;

/**
 * Zustand's `create` returns a hook that is also a `StoreApi`, so the legacy
 * chamber can be subscribed to through the same `useStore` call as the facade.
 * That is what keeps this to one subscription and one hook order across both
 * branches — the alternative, calling a hook per branch, subscribes to a store
 * the caller is not using.
 */
const LEGACY_STORE = legacyChamber as unknown as StoreApi<PanelChamberSlice>;

function useChamberStore(): StoreApi<PanelChamberSlice> {
  const facade = useOptionalAnimationChamberFacade();
  return facade?.store ?? LEGACY_STORE;
}

export function useChamber<T>(selector: (state: PanelChamberSlice) => T): T {
  return useStore(useChamberStore(), selector);
}

/**
 * The enclosing chamber's state, read outside React.
 *
 * The legacy hook carried a `getState` because a change handler needs the
 * current actions without subscribing to them. Outside a provider that is
 * still the legacy store; inside one there is no ambient answer, so callers on
 * the native path must read the facade instead — which is why this throws
 * rather than silently returning legacy state to a native panel.
 */
useChamber.getState = (): PanelChamberSlice => LEGACY_STORE.getState();

/**
 * The document collapsed to one motion context.
 *
 * The legacy chamber keys this by `weaponModeId` from a static catalogue; the
 * native chamber keys it by `motionContextId`, which comes from the subject's
 * resolved Motion Set (§16.4). Same collapse, same function — only the source
 * of the key differs, so the panels see one behaviour.
 */
/**
 * The motion contexts this subject actually has, and which one is selected.
 *
 * The panels used to enumerate `WEAPON_MODES`, a static catalogue in the
 * viewport's asset list. That is wrong in both directions: a Motion Set with a
 * context the catalogue never heard of showed no chip for it, and a Motion Set
 * missing one still showed a chip that resolved to the default clip. §16.4 asks
 * for the resolved keys instead, so the keys come from the document.
 *
 * The catalogue survives as an *ordering* — the chips keep the order a reader
 * of the donor UI would expect, and any resolved key the catalogue does not
 * know is appended rather than dropped.
 */
export function useMotionContext(): {
  contextKeys: string[];
  contextId: string;
  setContext: (id: string) => void;
} {
  const store = useChamberStore();
  const resolvedKeys = useStore(store, (state) => state.project.motionContextKeys);
  const contextId = useStore(store, selectContextId);
  const setNative = useStore(store, (state) => state.setMotionContext);
  const setLegacy = useStore(
    store,
    (state) => (state as unknown as { setWeaponMode?: (id: string) => void }).setWeaponMode,
  );
  const contextKeys = useMemo(() => orderedContextKeys(resolvedKeys ?? []), [resolvedKeys]);
  return { contextKeys, contextId, setContext: setNative ?? setLegacy ?? (() => {}) };
}

function orderedContextKeys(resolved: readonly string[]): string[] {
  const known = WEAPON_MODES.map((mode) => mode.id).filter((id) => resolved.includes(id));
  const extra = resolved.filter((key) => !known.includes(key)).sort();
  return [...known, ...extra];
}

function selectContextId(state: PanelChamberSlice): string {
  return (
    state.motionContextId ??
    (state as unknown as { weaponModeId?: string }).weaponModeId ??
    ''
  );
}

export function useWeaponProject(): PanelChamberSlice['project'] {
  const store = useChamberStore();
  const project = useStore(store, (state) => state.project);
  const contextId = useStore(store, selectContextId);
  return useMemo(() => resolveWeaponMode(project, contextId), [project, contextId]);
}
