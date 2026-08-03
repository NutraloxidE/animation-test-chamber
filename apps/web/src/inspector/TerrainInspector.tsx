/**
 * Terrain, reached by selecting the terrain row rather than by hunting for an
 * unrelated tab on the right.
 *
 * The panel body is the existing `TerrainPanel` — terrain tuning did not need
 * rewriting to become selectable, it needed a route. Wrapping rather than
 * reimplementing keeps the grounding debug readout and its tests exactly as
 * they were.
 */
import { TerrainPanel } from '../panels/TerrainPanel.tsx';

export function TerrainInspector() {
  return (
    <div className="inspector inspector--terrain" data-testid="terrain-inspector">
      <TerrainPanel />
    </div>
  );
}
