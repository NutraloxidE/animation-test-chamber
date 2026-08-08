export function GameOverlay({ sceneName }: { sceneName: string }): JSX.Element {
  return <section className="game-overlay" data-testid="game-overlay" aria-live="polite"><span>{sceneName}</span></section>;
}
