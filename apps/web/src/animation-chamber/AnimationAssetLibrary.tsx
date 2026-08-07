import { useMemo, useState } from 'react';
import { useAnimationChamber } from './useAnimationChamber.ts';

export function AnimationAssetLibrary(): JSX.Element {
  const document = useAnimationChamber((state) => state.project);
  const subject = useAnimationChamber((state) => state.subject);
  const publication = useAnimationChamber((state) => state.publication);
  const setStatus = useAnimationChamber((state) => state.setStatus);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const assets = useMemo(() => [
    { type: 'Behavior', id: subject.animator.assignment.behavior.assetId, version: subject.animator.assignment.behavior.version },
    { type: 'Motion Set', id: subject.animator.assignment.motionSet.assetId, version: subject.animator.assignment.motionSet.version },
    { type: 'Rig', id: subject.animator.assignment.rig.assetId, version: subject.animator.assignment.rig.version },
    ...Object.values(document.clipAssetSources).map((reference) => ({ type: 'Clip', id: reference.assetId, version: reference.version })),
  ].filter((asset) => `${asset.type} ${asset.id}`.toLowerCase().includes(query.toLowerCase())), [document, subject, query]);

  return (
    <section className="animation-asset-library" data-testid="asset-library">
      <header><h3>Asset Library</h3><span className="muted">Exact Animator: {subject.source.nodeId}/{subject.source.componentId}</span></header>
      <input aria-label="Search assets" placeholder="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ul>{assets.map((asset) => { const key = `${asset.type}:${asset.id}@${asset.version}`; return <li key={key}><button type="button" aria-pressed={selected === key} onClick={() => setSelected(key)}>{asset.type} {asset.id}@{asset.version}</button></li>; })}</ul>
      <button type="button" disabled={selected === null} onClick={() => setStatus(`Selected ${selected}. Selection changed no assignment. Use the exact Save Destination plan to publish an Animator assignment.`)}>Plan exact Animator assignment</button>
      <button type="button" onClick={() => publication.openPublication()}>Open Save Destination</button>
    </section>
  );
}
