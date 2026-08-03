/**
 * Live world observations, sampled off the simulation's critical path.
 *
 * Shared by every inspector that shows runtime state, so there is one sampling
 * cadence rather than one per panel — several independent 120ms intervals
 * would re-render the dock at whatever their least common multiple happened to
 * be, and "the inspector flickers" is a hard bug to attribute afterwards.
 */
import { useEffect, useState } from 'react';
import type { WorldObservation } from '@atc/world-runtime';
import { useChamber } from '../store.ts';

export function useObservations(): WorldObservation {
  const engine = useChamber((state) => state.worldEngine);
  const [observation, setObservation] = useState(() => engine.observe());
  useEffect(() => {
    const interval = window.setInterval(() => setObservation(engine.observe()), 120);
    return () => window.clearInterval(interval);
  }, [engine]);
  return observation;
}
