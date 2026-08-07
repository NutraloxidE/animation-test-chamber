# 0018 — The route location moves at default priority, not as a transition

## Status

Accepted.

## Context

The Asset Library's character `<select>`, and every plain `<Link>` in the app,
changed the URL and left the route component rendering the previous target
indefinitely. It reproduced on all three Playwright projects, logged nothing,
and looked correct when clicked by hand on a fast machine — which is why the
previous work package recorded it as an environment artifact rather than a
defect.

It is a defect. The diagnosis, in the order the evidence arrived:

```text
pathname changes                 history.pushState is called by react-router's Link handler
no page reload                   the load event count does not move
no console or page error         nothing is logged at all
useLocation() does not update    a probe rendered inside BrowserRouter never re-renders
history.listen IS subscribed     popstate is registered (twice, from StrictMode's remount)
StrictMode is not the cause      removing it changes nothing
useTransitions={false} fixes it  the probe re-renders and the route target updates
```

React Router v7's `BrowserRouter` commits the location inside
`React.startTransition`:

```js
React.startTransition(() => setStateImpl(newState));
```

That is the right default for an app whose routes suspend — the previous screen
stays up instead of flashing a fallback — but it makes the location a *low
priority* update, and a low priority update is abandoned and restarted whenever
a higher priority one arrives.

This app has no lazy routes and no route-level Suspense, so it gains nothing
from the transition. Meanwhile the chamber polls the engine into React state
every 100 ms (`App.tsx`), and a full chamber render under software-rendered
WebGL takes longer than that. Every poll preempted the in-flight transition and
restarted it from the beginning, so the location update was perpetually
re-rendered and never committed — while `history.pushState` had already moved
the address bar synchronously.

The result was a URL and a screen that disagreed, indefinitely, with no error
anywhere. On a fast machine the render finishes inside one poll interval and the
transition commits, which is exactly why manual verification kept saying the
feature worked.

## Decision

`BrowserRouter` is constructed with `useTransitions={false}`. The location
becomes an ordinary default-priority update.

`useTransitions` is a documented, typed prop on `BrowserRouterProps`. This is
the escape hatch it exists for.

## Why not the alternatives

**Reduce the polling instead.** Moving `App.tsx`'s 100 ms snapshot poll off
React state would make the starvation less likely, and it is worth doing on its
own merits. It is not a fix: it makes the race rarer rather than impossible, and
any future frequent update reintroduces it. A route that arrives only when the
renderer happens to be idle is not a route.

**Replace client-side navigation with `window.location.href`.** This would make
the test pass by removing the thing under test. The route-scoped editor model
(DECISION 0012) is built on client-side navigation; full page loads would
discard the session, the preview and the staged work on every character switch.

**Change the tests to `page.goto`.** A full document load re-reads the URL from
scratch and cannot fail this way, so the tests would stop covering the contract
that broke. The new tests in `tests/visual/routing/client-side-navigation.spec.ts`
navigate by clicking, and assert the rendered route target and its resolved
data — asserting the pathname alone passes against the bug.

## Consequences

- The URL is this app's selector (DECISION 0012), and it now applies
  unconditionally rather than when the renderer is free.
- If route-level Suspense or lazy route components are introduced later, this
  decision has to be revisited deliberately: without the transition, the next
  screen's fallback will be shown instead of holding the previous one. That is a
  trade worth making again on purpose, not a regression to rediscover.
- The three navigation failures that blocked the visual gate are gone, and the
  contract is covered by tests that fail if the location stops committing.
