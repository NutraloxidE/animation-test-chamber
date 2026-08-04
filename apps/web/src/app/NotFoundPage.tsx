/**
 * The stable state an unknown route id renders.
 *
 * It exists because the alternative is a fallback, and a fallback is worse than
 * an error here: `/edit/rig/typo` that quietly opens the first character looks
 * exactly like a working page, and the human tunes the wrong document. This
 * says which id failed and offers the ids that exist.
 */
import { Link } from 'react-router-dom';

export interface NotFoundLink {
  to: string;
  label: string;
}

export function NotFoundPage({
  title,
  detail,
  links,
}: {
  title: string;
  detail: string;
  links: NotFoundLink[];
}): JSX.Element {
  return (
    <main className="not-found" data-testid="route-not-found">
      <h1>{title}</h1>
      <p>{detail}</p>
      {links.length > 0 ? (
        <>
          <h2>Available</h2>
          <ul>
            {links.map((link) => (
              <li key={link.to}>
                <Link to={link.to}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>This project has none.</p>
      )}
      <p>
        <Link to="/">Back to the editor</Link>
      </p>
    </main>
  );
}
