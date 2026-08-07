/**
 * AI proposals on an exact subject.
 *
 * The failure these guard against is not "the AI produced a bad number". It is
 * a proposal generated against one Animator being applied to another, or a
 * proposal reaching the document through a route a human edit could not take —
 * bypassing protection because it came from a provider rather than a keyboard.
 *
 * The provider itself is the deterministic rule-based one, which is what a
 * static deployment falls back to. That makes these assertions about the
 * workspace's plumbing rather than about a model's taste.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getAtPath } from '@atc/runtime-core';
import { chamber } from './fixtures.ts';
import type { AnimationChamberStore } from '../../../apps/web/src/animation-chamber/AnimationChamberFacade.ts';

/**
 * No API server, so the browser-local provider runs.
 *
 * `backendAvailable()` caches its answer for the page's lifetime, and the
 * module under test imports it directly — so the probe is stubbed at the
 * network boundary rather than the module boundary, and the cache is what makes
 * one stub serve the whole file.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no API server in this test');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A transition the demo behaviour genuinely protects. */
const PROTECTED_TRANSITION = 'run-to-attack-01';

async function propose(store: AnimationChamberStore, request = 'make it snappier'): Promise<void> {
  // A replay must be selected for comparison slots to exist at all: a slot is a
  // run of one replay against several documents.
  store.getState().selectReplay(store.getState().replays[0]!.id);
  await store.getState().requestProposals(request);
}

describe('AI proposals target the current exact subject', () => {
  it('names the selected transition of this subject, not a Character', async () => {
    const { store } = chamber();
    const transitionId = store.getState().selectedTransitionId;
    expect(transitionId).not.toBe('');

    await propose(store);

    const proposals = store.getState().proposals;
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      for (const change of proposal.changes) {
        expect(change.path.startsWith(`/graph/transitions/${transitionId}/`)).toBe(true);
      }
    }
  });

  it('keeps proposal state inside the facade, so two subjects never share it', async () => {
    const first = chamber({ prefabId: 'subject-one' });
    const second = chamber({ prefabId: 'subject-two' });

    await propose(first.store);

    expect(first.store.getState().proposals.length).toBeGreaterThan(0);
    // The route rebuilds the facade on any change of subject identity, so a
    // second subject's workspace starts from nothing. Asserting it here is what
    // makes "reset on subject switch" a property of the design rather than of a
    // cleanup call somebody could forget.
    expect(second.store.getState().proposals).toEqual([]);
    expect(second.store.getState().compareSlots).toEqual([]);
    expect(second.store.getState().aiMessage).toBe('');
  });

  it('reports the browser-local provider when there is no API server', async () => {
    const { store } = chamber();
    await propose(store);
    expect(store.getState().aiBusy).toBe(false);
    expect(store.getState().aiMessage).toContain('running in the browser');
    expect(store.getState().backendOnline).toBe(false);
  });
});

describe('applying a proposal', () => {
  it('moves the preview and the running engine together', async () => {
    const { store, engine } = chamber();
    await propose(store);

    const proposal = store.getState().proposals[0]!;
    expect(proposal.changes.length).toBeGreaterThan(0);
    store.getState().applyProposal(proposal, false);

    for (const change of proposal.changes) {
      expect(getAtPath(store.getState().previewDocument, change.path)).toBe(change.after);
    }
    // The body on screen is part of the preview, not a separate view of it.
    expect(engine.currentProject).toBe(store.getState().previewDocument);
  });

  it('goes through the same protection gate a human edit does', async () => {
    const { store } = chamber();
    await propose(store);
    const session = store.getState().session;
    const gate = vi.spyOn(session, 'setPreviewValue');

    const proposal = store.getState().proposals[0]!;
    store.getState().applyProposal(proposal, false);

    // Not decoration: the only reason a protected path cannot be moved by a
    // proposal is that the proposal takes the same road a keyboard edit takes.
    // A future "fast path" that wrote the document directly would still pass
    // every value assertion above and silently unlock everything.
    expect(gate).toHaveBeenCalledTimes(proposal.changes.length);
    for (const call of gate.mock.calls) {
      expect(call[0]!.actor).toBe('ai');
      expect(call[0]!.approved).toBe(false);
    }
    gate.mockRestore();
  });

  it('leaves a locked field alone and says so', async () => {
    const { store } = chamber();
    // The demo behaviour locks `momentumRetention` on this transition and marks
    // the transition itself approval-required — a real protected path rather
    // than one invented for the test.
    store.getState().selectTransition(PROTECTED_TRANSITION);
    const before = getAtPath(
      store.getState().previewDocument,
      `/graph/transitions/${PROTECTED_TRANSITION}/momentumRetention`,
    );

    await propose(store, 'keep the mass but start sooner');

    const proposals = store.getState().proposals;
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(proposal.changes.some((change) => change.path.endsWith('/momentumRetention'))).toBe(
        false,
      );
      expect(proposal.protectedFieldsRespected.some((path) => path.endsWith('/momentumRetention'))).toBe(
        true,
      );
      // Approval-required on the transition means no variant may be taken
      // without an explicit human decision.
      expect(proposal.requiresApproval).toBe(true);
      store.getState().applyProposal(proposal, false);
    }

    expect(
      getAtPath(
        store.getState().previewDocument,
        `/graph/transitions/${PROTECTED_TRANSITION}/momentumRetention`,
      ),
    ).toBe(before);
  });

  it('does not authorise a repository write', async () => {
    const { store } = chamber();
    await propose(store);
    store.getState().applyProposal(store.getState().proposals[0]!, true);

    // Approval is about the proposal's own approval-required fields. Nothing
    // has been staged, so nothing is a candidate for publication.
    expect(store.getState().session.stagedPaths).toEqual([]);
    expect(store.getState().statusMessage).toContain('Nothing was written to the repository');
  });
});

describe('the proposal comparison set', () => {
  it('runs every slot against the same replay, seeded from the same engine', async () => {
    const { store } = chamber();
    await propose(store);

    const slots = store.getState().compareSlots;
    const proposals = store.getState().proposals;

    expect(slots.map((slot) => slot.label).slice(0, 2)).toEqual(['Repository', 'Preview']);
    // One column per proposal, beyond the two baselines — which is what makes
    // the set an A/B/C comparison rather than a before/after wearing the label.
    expect(slots.filter((slot) => slot.proposal !== null)).toHaveLength(proposals.length);
    for (const slot of slots) {
      expect(slot.trace).not.toBeNull();
      expect(slot.subjectId).toBe(store.getState().subject.subjectId);
    }
  });

  it('previews a slot by re-seeding the one engine', async () => {
    const { store, engine } = chamber();
    await propose(store);

    const index = store.getState().compareSlots.findIndex((slot) => slot.proposal !== null);
    expect(index).toBeGreaterThan(-1);
    store.getState().activateCompareSlot(index);

    expect(engine.currentProject).toBe(store.getState().compareSlots[index]!.document);
    expect(store.getState().activeCompareSlot).toBe(index);
  });

  it('does not apply a proposal merely because its column was viewed', async () => {
    const { store } = chamber();
    await propose(store);
    const preview = store.getState().previewDocument;

    const index = store.getState().compareSlots.findIndex((slot) => slot.proposal !== null);
    store.getState().activateCompareSlot(index);

    // Looking at a variant must be distinguishable from taking it.
    expect(store.getState().previewDocument).toBe(preview);
    expect(store.getState().session.diff().changes).toEqual([]);
  });

  it('has no proposal columns for a subject that was never asked', () => {
    const { store } = chamber();
    store.getState().selectReplay(store.getState().replays[0]!.id);
    store.getState().buildCompareSlots();

    const slots = store.getState().compareSlots;
    expect(slots).toHaveLength(2);
    expect(slots.every((slot) => slot.proposal === null)).toBe(true);
  });
});
