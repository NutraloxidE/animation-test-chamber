/**
 * Parsing one untrusted value into a `RepositoryApplyRequest`.
 *
 * The schema in `@atc/schema` says what a valid request *is*; this says what a
 * caller is *told* when theirs is not one, and the two are different jobs. Ajv
 * reports a failed union as every member's failure at once, so a request with
 * one misspelled field comes back as a dozen simultaneous complaints, none of
 * which name the misspelling. A caller that cannot find its own typo in the
 * response will assume the server is broken, and on the evidence available to
 * them that is a reasonable conclusion.
 *
 * So the checks run outermost-first — is this an object, does it have a target,
 * is that target one of the two kinds — and each layer answers before the next
 * one can produce noise.
 */
import type { RepositoryApplyRequest, ValidationIssue } from '@atc/schema';
import { validateAgainst } from '@atc/schema';
import { parseSceneGameObjectOperation } from './game-object-operations.ts';

export type ParsedApplyRequest =
  | { ok: true; request: RepositoryApplyRequest }
  | { ok: false; issues: ValidationIssue[] };

function issue(path: string, message: string, keyword: string): ValidationIssue {
  return { path, message, keyword };
}

const TARGET_KINDS = ['character', 'scene'] as const;

/**
 * Validates `value` as a complete Apply request.
 *
 * Nothing here loads repository state or replays anything. The entire request
 * is proven well-formed before the server reads a single canonical byte,
 * because a request that is going to be refused as malformed should not have
 * cost a file read, and — more importantly — should never have reached the code
 * that mutates anything.
 */
export function parseRepositoryApplyRequest(value: unknown): ParsedApplyRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [issue('/', 'request body must be a JSON object', 'shape')] };
  }
  const body = value as Record<string, unknown>;

  /*
   * The target's `kind` is checked by hand before the schema, for the reason
   * `parseSceneOperation` checks an operation's `type` by hand: a union of two
   * closed objects reports an unknown discriminator as two failures that both
   * complain about the *other* kind's literal, and neither says "kind must be
   * character or scene".
   */
  const target = body.target;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return { ok: false, issues: [issue('/target', 'target is required and must be an object', 'shape')] };
  }
  const kind = (target as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(TARGET_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      issues: [
        issue(
          '/target/kind',
          `unknown target kind ${JSON.stringify(kind)}; expected one of ${TARGET_KINDS.join(', ')}`,
          'enum',
        ),
      ],
    };
  }

  /*
   * Operations are parsed individually first, so an unrecognised operation is
   * reported by name rather than as a thirteen-member union dump. This is a
   * strictly narrower check than the request schema's — every operation the
   * loop accepts, the schema accepts too — so it cannot let anything through
   * that the full validation below would have refused.
   *
   * Since the Scene cutover these are *GameObject* operations. A client still
   * sending `scene.place_asset` or `scene.delete_entity` is told so by name,
   * which is the one thing a union dump could never have told it.
   */
  const operations = body.operations;
  if (!Array.isArray(operations)) {
    return {
      ok: false,
      issues: [issue('/operations', 'operations is required and must be an array', 'shape')],
    };
  }
  for (const [position, candidate] of operations.entries()) {
    const parsed = parseSceneGameObjectOperation(candidate);
    if (parsed.ok) continue;
    return {
      ok: false,
      issues: parsed.issues.map((entry) => ({
        ...entry,
        path: `/operations/${position}${entry.path === '/' ? '' : entry.path}`,
      })),
    };
  }

  // Everything the hand-rolled checks above could not say is said here, closed
  // boundaries included: an unknown top-level or nested property fails at this
  // step and nowhere earlier.
  const result = validateAgainst('RepositoryApplyRequest', body);
  if (!result.valid) return { ok: false, issues: result.issues };

  return { ok: true, request: body as unknown as RepositoryApplyRequest };
}
