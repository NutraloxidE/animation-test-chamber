import { useState } from 'react';
import type { CandidateAsset, LicenseFlag } from '@atc/schema';
import { useChamber } from '../store.ts';
import { backendAvailable, NO_BACKEND_MESSAGE } from '../backend.ts';

const FLAGS: LicenseFlag[] = ['unknown', 'allowed', 'forbidden'];

interface ImportResponse {
  candidate: CandidateAsset | null;
  pendingJob: { format: string; reason: string } | null;
  job?: { status: string; message: string };
  errors?: string[];
  rawAssetCommit?: { allowed: boolean; reasons: string[] };
  error?: string;
}

/**
 * Animation Acquisition (PLAN 15). The licence answers default to `unknown` and
 * must be filled in deliberately — the panel will not let an unverified raw
 * asset be treated as committable.
 */
export function AcquisitionPanel() {
  const setStatus = useChamber((state) => state.setStatus);
  const offline = useChamber((state) => state.backendOnline) === false;
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [license, setLicense] = useState({
    provider: 'manual-import',
    commercialUse: 'unknown' as LicenseFlag,
    rawAssetRedistribution: 'unknown' as LicenseFlag,
    teamSharing: 'unknown' as LicenseFlag,
    publicRepository: 'unknown' as LicenseFlag,
    attributionRequired: 'unknown' as LicenseFlag,
    verificationStatus: 'unverified' as 'unverified' | 'human-verified',
  });

  const onFile = async (file: File): Promise<void> => {
    // Import registers a candidate and may queue a conversion job; both live on
    // the server, so there is nothing to hand the file to on a static host.
    if (!(await backendAvailable())) {
      setStatus(`Import: ${NO_BACKEND_MESSAGE}`);
      return;
    }
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }

      const response = await fetch('/api/acquisition/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          content: btoa(binary),
          license,
          repositoryIsPublic: true,
        }),
      });
      const payload = (await response.json()) as ImportResponse;
      setResult(payload);
      setStatus(
        payload.candidate
          ? `Imported "${file.name}" as candidate ${payload.candidate.id} (${payload.candidate.state}).`
          : payload.pendingJob
            ? `Pending conversion job: ${payload.pendingJob.reason}`
            : `Import failed: ${payload.error ?? payload.errors?.join('; ')}`,
      );
    } catch (error) {
      setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" data-testid="acquisition-panel">
      <header className="panel__header">
        <h2>Animation Acquisition</h2>
      </header>

      <p className="muted small">
        GLB imports directly. FBX and BVH require the animation worker; without it they are recorded
        as an explicit pending job rather than silently failing.
      </p>

      <h3>Licence manifest</h3>
      <p className="muted small">
        Unknown is never treated as permission. Anything left unknown blocks committing the raw
        asset.
      </p>

      <label className="inline-field">
        Provider
        <input
          value={license.provider}
          onChange={(event) => setLicense({ ...license, provider: event.target.value })}
        />
      </label>

      {(
        [
          ['commercialUse', 'Commercial use'],
          ['rawAssetRedistribution', 'Raw asset redistribution'],
          ['teamSharing', 'Team sharing'],
          ['publicRepository', 'Public repository'],
          ['attributionRequired', 'Attribution required'],
        ] as const
      ).map(([key, label]) => (
        <label className="inline-field" key={key}>
          {label}
          <select
            value={license[key]}
            onChange={(event) => setLicense({ ...license, [key]: event.target.value as LicenseFlag })}
          >
            {FLAGS.map((flag) => (
              <option key={flag} value={flag}>
                {flag}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label className="inline-field">
        <input
          type="checkbox"
          checked={license.verificationStatus === 'human-verified'}
          onChange={(event) =>
            setLicense({
              ...license,
              verificationStatus: event.target.checked ? 'human-verified' : 'unverified',
            })
          }
        />
        I have read these licence terms myself
      </label>

      <label className="inline-field">
        Animation file
        <input
          type="file"
          accept=".glb,.gltf,.fbx,.bvh"
          disabled={busy || offline}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
      </label>
      {offline && (
        <p className="muted small">
          Importing needs the API server, which registers the candidate and queues conversion.
        </p>
      )}

      {result?.candidate && (
        <section className="candidate">
          <h3>Candidate: {result.candidate.id}</h3>
          <p>
            State: <strong>{result.candidate.state}</strong> · {result.candidate.discoveredClips.length}{' '}
            clip(s) · {result.candidate.durationSec.toFixed(2)}s
          </p>
          <p className="muted small">
            An imported asset never replaces a live clip. It stays a candidate until a human marks it
            HumanAccepted.
          </p>
          {result.candidate.issues.length > 0 && (
            <ul className="findings">
              {result.candidate.issues.map((issue, index) => (
                <li key={index} className="finding finding--warning">
                  {issue}
                </li>
              ))}
            </ul>
          )}
          {result.rawAssetCommit && (
            <p className={result.rawAssetCommit.allowed ? 'ok' : 'finding finding--blocking'}>
              {result.rawAssetCommit.allowed
                ? 'Raw asset may be committed to a public repository.'
                : `Raw asset commit refused: ${result.rawAssetCommit.reasons.join('; ')}`}
            </p>
          )}
        </section>
      )}

      {result?.pendingJob && (
        <section className="candidate">
          <h3>Pending conversion</h3>
          <p>{result.pendingJob.reason}</p>
          {result.job && (
            <p className="muted small">
              Worker status: <strong>{result.job.status}</strong> — {result.job.message}
            </p>
          )}
        </section>
      )}

      {result?.errors && result.errors.length > 0 && (
        <ul className="findings">
          {result.errors.map((error, index) => (
            <li key={index} className="finding finding--blocking">
              {error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
