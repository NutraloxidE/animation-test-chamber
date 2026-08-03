/**
 * The scope label — who else does this change affect?
 *
 * Rendered as a word, never as a colour alone. A user deciding whether a
 * shield toggle affects one instance or every instance in the project cannot
 * do it from a hue, and the failure mode is silent: they only find out later,
 * on the other instance.
 */
export type Scope = 'INSTANCE' | 'SHARED' | 'PREVIEW' | 'RUNTIME' | 'INHERITED' | 'OVERRIDDEN';

const EXPLANATION: Record<Scope, string> = {
  INSTANCE: 'Instance-scoped: changing this affects only the selected instance.',
  SHARED: 'Shared definition: changing this affects every instance that references it.',
  PREVIEW: 'Temporary preview: not saved, and cleared without touching authored data.',
  RUNTIME: 'Live runtime result, not an authored value. Read-only.',
  INHERITED: 'Following the character definition — this instance has no override.',
  OVERRIDDEN: 'This instance overrides the character definition default.',
};

export function ScopeBadge({ scope }: { scope: Scope }) {
  return (
    <span
      className={`scope-badge scope-badge--${scope.toLowerCase()}`}
      title={EXPLANATION[scope]}
      data-testid={`scope-${scope.toLowerCase()}`}
    >
      {scope}
    </span>
  );
}
