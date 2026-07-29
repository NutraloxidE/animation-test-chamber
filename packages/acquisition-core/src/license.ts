import type { LicenseFlag, LicenseManifest } from '@atc/schema';

export interface LicenseDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * Whether the raw, unmodified asset may be committed to a repository.
 *
 * `unknown` is treated exactly like `forbidden` here. That is the whole point of
 * the tri-state (PLAN 15.6): a missing licence answer must never be optimistically
 * resolved to "allowed" by tooling, so an unverified asset simply cannot reach a
 * public repo.
 */
export function canCommitRawAsset(
  manifest: LicenseManifest,
  options: { repositoryIsPublic: boolean },
): LicenseDecision {
  const reasons: string[] = [];

  const blockedBy = (flag: LicenseFlag, label: string): void => {
    if (flag === 'forbidden') reasons.push(`${label} is forbidden by the licence`);
    if (flag === 'unknown') reasons.push(`${label} is unknown and is not assumed to be allowed`);
  };

  blockedBy(manifest.rawAssetRedistribution, 'raw asset redistribution');
  if (options.repositoryIsPublic) {
    blockedBy(manifest.publicRepository, 'inclusion in a public repository');
  } else {
    blockedBy(manifest.teamSharing, 'team sharing');
  }

  if (manifest.verificationStatus !== 'human-verified') {
    reasons.push('licence terms have not been verified by a human');
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Metadata is always committable — it carries no licensed content, and losing
 * it would make the asset untraceable, which is worse.
 */
export function canCommitMetadata(): LicenseDecision {
  return { allowed: true, reasons: [] };
}

/** A manifest with every unknowable field honestly marked unknown. */
export function unknownLicenseManifest(options: {
  provider: string;
  sourceType: LicenseManifest['sourceType'];
  sourceRef: string;
  acquiredBy: string;
  acquiredAt?: string;
}): LicenseManifest {
  return {
    schemaVersion: 1,
    provider: options.provider,
    sourceType: options.sourceType,
    sourceRef: options.sourceRef,
    acquiredBy: options.acquiredBy,
    acquiredAt: options.acquiredAt ?? new Date().toISOString(),
    commercialUse: 'unknown',
    rawAssetRedistribution: 'unknown',
    teamSharing: 'unknown',
    publicRepository: 'unknown',
    attributionRequired: 'unknown',
    verificationStatus: 'unverified',
  };
}

/** Fields a human still has to answer before the asset can be committed. */
export function missingLicenseAnswers(manifest: LicenseManifest): string[] {
  const missing: string[] = [];
  const check = (flag: LicenseFlag, label: string): void => {
    if (flag === 'unknown') missing.push(label);
  };
  check(manifest.commercialUse, 'commercialUse');
  check(manifest.rawAssetRedistribution, 'rawAssetRedistribution');
  check(manifest.teamSharing, 'teamSharing');
  check(manifest.publicRepository, 'publicRepository');
  check(manifest.attributionRequired, 'attributionRequired');
  if (manifest.verificationStatus !== 'human-verified') missing.push('verificationStatus');
  return missing;
}
