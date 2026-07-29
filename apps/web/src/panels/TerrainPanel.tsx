import { useEffect, useState } from 'react';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { useChamber } from '../store.ts';
import { Field, ToggleField } from './Field.tsx';

/** Terrain tuning and live grounding debug (PLAN 11). */
export function TerrainPanel() {
  const engine = useChamber((state) => state.engine);
  const terrainPresetId = useChamber((state) => state.terrainPresetId);
  const setTerrainPreset = useChamber((state) => state.setTerrainPreset);
  const [live, setLive] = useState(() => engine.simulationState);

  useEffect(() => engine.subscribe(() => setLive(engine.simulationState)), [engine]);

  const ik = live.footIk;

  return (
    <div className="panel" data-testid="terrain-panel">
      <header className="panel__header">
        <h2>Terrain</h2>
      </header>

      <select
        className="wide"
        value={terrainPresetId}
        onChange={(event) => setTerrainPreset(event.target.value)}
        data-testid="terrain-select"
      >
        {TERRAIN_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>

      <table className="capability">
        <tbody>
          <tr>
            <td>Terrain state</td>
            <td>
              <strong>{live.terrain.state}</strong>
            </td>
          </tr>
          <tr>
            <td>Grounded</td>
            <td className={live.grounded ? 'ok' : 'off'}>{String(live.grounded)}</td>
          </tr>
          <tr>
            <td>Surface</td>
            <td>{live.terrain.surface.id}</td>
          </tr>
          <tr>
            <td>Slope</td>
            <td>{((live.terrain.slopeRad * 180) / Math.PI).toFixed(1)}°</td>
          </tr>
          <tr>
            <td>Ground normal</td>
            <td>
              ({live.terrain.normal.x.toFixed(2)}, {live.terrain.normal.y.toFixed(2)},{' '}
              {live.terrain.normal.z.toFixed(2)})
            </td>
          </tr>
          <tr>
            <td>Penetration</td>
            <td className={live.terrain.penetration > 0.01 ? 'off' : 'ok'}>
              {live.terrain.penetration.toFixed(4)} m
            </td>
          </tr>
          <tr>
            <td>Floating</td>
            <td className={live.terrain.floating > 0.01 ? 'off' : 'ok'}>
              {live.terrain.floating.toFixed(4)} m
            </td>
          </tr>
          {ik && (
            <>
              <tr>
                <td>Foot sliding (L/R)</td>
                <td>
                  {ik.left.slidingDistance.toFixed(4)} / {ik.right.slidingDistance.toFixed(4)} m
                </td>
              </tr>
              <tr>
                <td>Foot contact (L/R)</td>
                <td>
                  {String(ik.left.contact)} / {String(ik.right.contact)}
                </td>
              </tr>
              <tr>
                <td>Ankle rotation (L/R)</td>
                <td>
                  {((ik.left.ankleRotationRad * 180) / Math.PI).toFixed(1)}° /{' '}
                  {((ik.right.ankleRotationRad * 180) / Math.PI).toFixed(1)}°
                </td>
              </tr>
              <tr>
                <td>Pelvis offset</td>
                <td>{ik.pelvisOffset.toFixed(4)} m</td>
              </tr>
            </>
          )}
          <tr>
            <td>Root motion vs actual</td>
            <td>
              {live.authoredRootDisplacement.toFixed(2)} / {live.actualDisplacement.toFixed(2)} m
            </td>
          </tr>
        </tbody>
      </table>

      <p className="muted small">
        Foot markers and the ground normal are drawn in the viewport while this panel is open.
      </p>

      <h3>Ground probe</h3>
      <Field path="/terrain/groundProbeDistance" label="Probe distance" min={0.05} max={1} step={0.01} />
      <Field path="/terrain/probeRadius" label="Probe radius" min={0.05} max={1} step={0.01} />
      <Field path="/terrain/groundSnapStrength" label="Ground snap" min={0} max={1} step={0.01} />
      <Field path="/terrain/downhillAdhesion" label="Downhill adhesion" min={0} max={1} step={0.01} />
      <Field path="/terrain/stepUpHeight" label="Step-up height" min={0} max={1} step={0.01} />
      <Field
        path="/terrain/maxWalkableSlopeRad"
        label="Max walkable slope"
        min={0}
        max={1.4}
        step={0.01}
        format={(value) => `${((value * 180) / Math.PI).toFixed(0)}°`}
      />
      <Field
        path="/terrain/slideStartAngleRad"
        label="Slide start angle"
        min={0}
        max={1.4}
        step={0.01}
        format={(value) => `${((value * 180) / Math.PI).toFixed(0)}°`}
      />
      <Field
        path="/terrain/slopeSpeedCompensation"
        label="Slope speed compensation"
        min={-1}
        max={1}
        step={0.01}
      />
      <Field path="/terrain/ledgeDetectDistance" label="Ledge detect distance" min={0} max={2} step={0.01} />
      <Field path="/terrain/obstaclePushback" label="Obstacle pushback" min={0} max={1} step={0.01} />

      <h3>Foot IK</h3>
      <Field path="/terrain/footIkStrength" label="Foot IK strength" min={0} max={1} step={0.01} />
      <Field path="/terrain/footTargetSmoothing" label="Foot smoothing" min={0} max={0.95} step={0.01} />
      <Field path="/terrain/pelvisOffsetStrength" label="Pelvis offset" min={0} max={1} step={0.01} />
      <ToggleField path="/terrain/rootMotionTerrainProjection" label="Project root motion onto terrain" />

      <h3>Moving platforms</h3>
      <Field
        path="/terrain/movingPlatformVelocityInheritance"
        label="Velocity inheritance"
        min={0}
        max={1}
        step={0.01}
      />
      <Field
        path="/terrain/movingPlatformRotationInheritance"
        label="Rotation inheritance"
        min={0}
        max={1}
        step={0.01}
      />

      <h3>Movement</h3>
      <Field path="/movement/walkSpeed" label="Walk speed" min={0} max={6} step={0.05} />
      <Field path="/movement/runSpeed" label="Run speed" min={0} max={14} step={0.05} />
      <Field path="/movement/acceleration" label="Acceleration" min={1} max={80} step={0.5} />
      <Field path="/movement/deceleration" label="Deceleration" min={1} max={80} step={0.5} />
      <Field path="/movement/rotationSpeed" label="Rotation speed" min={1} max={30} step={0.1} />
      <Field path="/movement/airControl" label="Air control" min={0} max={1} step={0.01} />
      <Field path="/movement/jumpHeight" label="Jump height" min={0.1} max={4} step={0.01} />
      <Field path="/movement/gravity" label="Gravity" min={1} max={50} step={0.1} />
      <Field path="/movement/actionMovementAuthority" label="Action movement authority" min={0} max={1} step={0.01} />

      <h3>Root motion</h3>
      <Field path="/rootMotion/horizontalAuthority" label="Horizontal authority" min={0} max={1} step={0.01} />
      <Field path="/rootMotion/verticalAuthority" label="Vertical authority" min={0} max={1} step={0.01} />
      <Field path="/rootMotion/rotationAuthority" label="Rotation authority" min={0} max={1} step={0.01} />
    </div>
  );
}
