/**
 * The three production stages, always visible.
 *
 * Not behind an `Editor` button, not a stop on the View cycle, not one of nine
 * bottom tabs. The sequence Project → Character Lab → World *is* the product's
 * shape, and a user who cannot see it has to be told it exists.
 */
import { useChamber } from '../store.ts';
import {
  PRIMARY_WORKSPACES,
  PRIMARY_WORKSPACE_LABEL,
  PRIMARY_WORKSPACE_PURPOSE,
} from './primary-workspace.ts';

export function PrimaryWorkspaceNav() {
  const workspace = useChamber((state) => state.primaryWorkspace);
  const setWorkspace = useChamber((state) => state.setPrimaryWorkspace);

  return (
    <nav className="primary-nav" data-testid="primary-nav" aria-label="Production stage">
      {PRIMARY_WORKSPACES.map((entry, index) => (
        <span key={entry} className="primary-nav__item">
          {/* A separator rather than a decoration: it is what says these are
              ordered stages and not three peers you pick between. */}
          {index > 0 && (
            <span className="primary-nav__arrow" aria-hidden="true">
              →
            </span>
          )}
          <button
            type="button"
            className={workspace === entry ? 'is-active' : ''}
            aria-current={workspace === entry ? 'page' : undefined}
            title={PRIMARY_WORKSPACE_PURPOSE[entry]}
            data-testid={`primary-nav-${entry}`}
            onClick={() => setWorkspace(entry)}
          >
            {PRIMARY_WORKSPACE_LABEL[entry]}
          </button>
        </span>
      ))}
    </nav>
  );
}
