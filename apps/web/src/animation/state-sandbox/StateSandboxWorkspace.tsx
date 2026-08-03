/**
 * State Sandbox — the runtime half of the animation split.
 *
 * Everything here executes for real, in a simulation that is not the world's.
 * The banner says RUNTIME SIMULATION rather than PREVIEW because that is the
 * true statement: transitions fire, events emit, recovery runs and root motion
 * moves the sandbox character. What it does *not* do is touch the live world,
 * and that is structural — the engine holds a `Simulation` it built itself from
 * an immutable resolved document, with no reference to `WorldRuntime` at all.
 */
import { useEffect } from 'react';
import { useChamber } from '../../store.ts';
import { ScopeBadge } from '../../inspector/sections/ScopeBadge.tsx';
import { AnimationTargetHeader } from '../target/AnimationTargetHeader.tsx';
import { useAnimationTarget } from '../target/useAnimationTarget.ts';
import { StateSandboxControls } from './StateSandboxControls.tsx';
import { StateSandboxObservation } from './StateSandboxObservation.tsx';

export function StateSandboxWorkspace() {
  const { resolved } = useAnimationTarget();
  const engine = useChamber((state) => state.sandboxEngine);
  const sandbox = useChamber((state) => state.sandbox);
  const rebuild = useChamber((state) => state.rebuildSandbox);
  const stepSandbox = useChamber((state) => state.stepSandbox);
  // The observation is read fresh whenever anything the engine could have moved
  // changes; `revision` is bumped by `stepSandbox`.
  const revision = useChamber((state) => state.revision);

  const target = resolved?.ok ? resolved.target : null;

  useEffect(() => {
    if (target && !engine) rebuild();
  }, [target, engine, rebuild]);

  /*
   * Playback is a wall-clock timer that asks for whole ticks, never a
   * wall-clock delta fed to the simulation. The sandbox is fixed-step for the
   * same reason the world is: a run that depends on frame timing is a run
   * nobody can reproduce, and reset determinism is one of the things this panel
   * exists to demonstrate.
   */
  useEffect(() => {
    if (!sandbox.playing || !engine) return;
    const id = window.setInterval(() => {
      const ticks = Math.max(1, Math.round(sandbox.speed));
      stepSandbox(ticks);
    }, 1000 / 60);
    return () => window.clearInterval(id);
  }, [sandbox.playing, sandbox.speed, engine, stepSandbox]);

  const observation = engine ? engine.observation() : null;
  void revision;

  return (
    <div className="workspace workspace--state-sandbox" data-testid="state-sandbox">
      <header className="workspace__header">
        <h2>State Sandbox</h2>
        <ScopeBadge scope="PREVIEW" />
        <span className="workspace__badge" data-testid="sandbox-runtime-badge">
          RUNTIME SIMULATION
        </span>
        <span className="workspace__badge">TEMPORARY</span>
      </header>

      <p className="workspace__banner" data-testid="sandbox-semantics">
        <b>RUNTIME SIMULATION.</b> Transitions, exit times, cancel windows, buffered input, semantic
        events, recovery and root motion all execute — in a separate disposable simulation. The live
        world is not advanced, moved or recorded by anything on this panel.
      </p>

      <AnimationTargetHeader />

      {!target ? (
        <p className="workspace__hint" data-testid="sandbox-no-target">
          Select an instance in the Hierarchy — or pin one — to run its behaviour in a sandbox.
        </p>
      ) : (
        <>
          <StateSandboxControls target={target} />
          <StateSandboxObservation observation={observation} />
        </>
      )}
    </div>
  );
}
