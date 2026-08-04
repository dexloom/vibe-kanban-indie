/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, KanbanCards } from './KanbanBoard';
import {
  DragActiveProvider,
  DragCandidateProvider,
  DragInsertionProvider,
  DragSourceProvider,
  type InsertionPoint,
} from './outliner/dragState';

afterEach(cleanup);

interface ProbeCardProps {
  issueId: string;
  label: string;
}

/** Minimal stand-in for `KanbanCard`: a `<div data-dnd-card>` carrying the
 * `data-dnd-card-issue-id` the DOM-order lookup inside `KanbanCards` keys
 * off. We do not need `useDraggable` / the controller here. */
function ProbeCard({ issueId, label }: ProbeCardProps) {
  return (
    <div data-dnd-card="" data-dnd-card-issue-id={issueId}>
      {label}
    </div>
  );
}

describe('KanbanCards insertion indicator', () => {
  it('inserts the indicator at the adjusted slot (source A, index 1 in [A,B,C] lands between B and C)', async () => {
    const COL_ID = 'col-1';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 1, // slot 1 against [B, C] (source A excluded)
      sourceIssueId: 'A',
    };
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value={COL_ID}>
          <DragInsertionProvider value={insertion}>
            <KanbanCards id={COL_ID} activeProjectId="p1">
              <ProbeCard issueId="A" label="A" />
              <ProbeCard issueId="B" label="B" />
              <ProbeCard issueId="C" label="C" />
            </KanbanCards>
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>,
    );

    const col = container.firstElementChild!;
    // The source-card DOM lookup needs a mounted container, so the
    // adjusted indicator only appears on the second render. Wait for it.
    await waitFor(() => {
      expect(
        col.querySelectorAll('[data-dnd-insertion-indicator]').length,
      ).toBeGreaterThan(0);
    });
    const indicatorCount = col.querySelectorAll(
      '[data-dnd-insertion-indicator]',
    ).length;
    expect(indicatorCount).toBe(1);
    // Round-5 placeholder: dashed-border slot, NOT the old 2px bar.
    const indicator = col.querySelector(
      '[data-dnd-insertion-indicator]',
    ) as HTMLElement;
    expect(indicator.className).toContain('border-dashed');
    expect(indicator.className).toContain('border-brand');
    expect(indicator.style.height).toBeTruthy();
    // Indicator sits between B and C in DOM order.
    const kids = Array.from(col.children);
    const indicatorIdx = kids.findIndex((el) =>
      el.hasAttribute('data-dnd-insertion-indicator'),
    );
    const bIdx = kids.findIndex(
      (el) => el.getAttribute('data-dnd-card-issue-id') === 'B',
    );
    const cIdx = kids.findIndex(
      (el) => el.getAttribute('data-dnd-card-issue-id') === 'C',
    );
    expect(indicatorIdx).toBe(bIdx + 1);
    expect(indicatorIdx).toBe(cIdx - 1);
  });

  it('inserts the indicator at index 0 (no source, slot 0 in [B, C])', () => {
    const COL_ID = 'col-2';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 0,
      sourceIssueId: null,
    };
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value={COL_ID}>
          <DragInsertionProvider value={insertion}>
            <KanbanCards id={COL_ID} activeProjectId="p1">
              <ProbeCard issueId="B" label="B" />
              <ProbeCard issueId="C" label="C" />
            </KanbanCards>
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>,
    );

    const col = container.firstElementChild!;
    const indicators = col.querySelectorAll('[data-dnd-insertion-indicator]');
    expect(indicators.length).toBe(1);
    // Indicator sits before both cards.
    const indicator = indicators[0] as HTMLElement;
    expect(
      indicator.compareDocumentPosition(col.children[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(indicator.className).toContain('border-dashed');
    expect(indicator.style.height).toBeTruthy();
  });

  it('appends the indicator at the end when the adjusted slot equals the children length', async () => {
    const COL_ID = 'col-3';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 1,
      sourceIssueId: 'A',
    };
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value={COL_ID}>
          <DragInsertionProvider value={insertion}>
            <KanbanCards id={COL_ID} activeProjectId="p1">
              <ProbeCard issueId="A" label="A" />
              <ProbeCard issueId="B" label="B" />
            </KanbanCards>
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>,
    );

    const col = container.firstElementChild!;
    await waitFor(() => {
      expect(
        col.querySelectorAll('[data-dnd-insertion-indicator]').length,
      ).toBe(1);
    });
    // sourceFullIndex=0, raw index=1 → adjustInsertionIndex → 2. Children
    // length is 2 → indicator appended at the end.
    const indicators = col.querySelectorAll('[data-dnd-insertion-indicator]');
    expect(indicators.length).toBe(1);
    // Indicator follows B in DOM order (compareDocumentPosition: the
    // B node precedes the indicator → PRECEDING bit set on the
    // indicator's view of B).
    expect(
      indicators[0]!.compareDocumentPosition(
        col.querySelector('[data-dnd-card-issue-id="B"]')!,
      ) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(indicators[0]!.className).toContain('border-dashed');
  });

  it('hides the indicator when positionalReorderEnabled={false} (non-positional sort mode would re-sort the card)', () => {
    const COL_ID = 'col-4';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 1,
      sourceIssueId: 'A',
    };
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value={COL_ID}>
          <DragInsertionProvider value={insertion}>
            <KanbanCards
              id={COL_ID}
              activeProjectId="p1"
              positionalReorderEnabled={false}
            >
              <ProbeCard issueId="A" label="A" />
              <ProbeCard issueId="B" label="B" />
            </KanbanCards>
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>,
    );

    const col = container.firstElementChild!;
    expect(col.querySelectorAll('[data-dnd-insertion-indicator]').length).toBe(
      0,
    );
  });

  it('placeholder height is measured from the first card in the column', async () => {
    // Round-5: the insertion placeholder is a slot the size of a card,
    // not a 2px bar. `KanbanCards` reads the first card's
    // `getBoundingClientRect().height` and writes it into the
    // placeholder's inline style. jsdom returns 0/0/0/0 by default —
    // stub the prototype to assert the wiring.
    const COL_ID = 'col-measured';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 0,
      sourceIssueId: null,
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 84,
        width: 100,
        height: 84,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      const { container } = render(
        <DragActiveProvider value={true}>
          <DragCandidateProvider value={COL_ID}>
            <DragInsertionProvider value={insertion}>
              <KanbanCards id={COL_ID} activeProjectId="p1">
                <ProbeCard issueId="A" label="A" />
                <ProbeCard issueId="B" label="B" />
              </KanbanCards>
            </DragInsertionProvider>
          </DragCandidateProvider>
        </DragActiveProvider>,
      );
      const indicator = container.querySelector(
        '[data-dnd-insertion-indicator]',
      ) as HTMLElement;
      await waitFor(() => {
        expect(indicator.style.height).toBe('84px');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('empty column uses the fallback placeholder height (no cards to measure)', async () => {
    const COL_ID = 'col-empty';
    const insertion: InsertionPoint = {
      targetId: COL_ID,
      index: 0,
      sourceIssueId: null,
    };
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value={COL_ID}>
          <DragInsertionProvider value={insertion}>
            <KanbanCards id={COL_ID} activeProjectId="p1">
              {null}
            </KanbanCards>
          </DragInsertionProvider>
        </DragCandidateProvider>
      </DragActiveProvider>,
    );
    const indicator = container.querySelector(
      '[data-dnd-insertion-indicator]',
    ) as HTMLElement;
    await waitFor(() => {
      // Fallback is 60px; jsdom's zero-rect means measurement yields 0,
      // so the empty-column branch owns the fallback value.
      expect(indicator.style.height).toBe('60px');
    });
  });
});

describe('KanbanCard source dim', () => {
  it('applies opacity-50 to the dragged source card; other cards stay opaque', () => {
    // Round-5: the source card dims to signal "this is being moved".
    // The source id lives in its own context (`DragSourceContext`) so a
    // re-render that flips it doesn't invalidate the insertion
    // consumers (separate context split, same render-storm discipline
    // as DragActive / DragCandidate).
    const { container } = render(
      <DragSourceProvider value="A">
        <KanbanCard
          source={{ kind: 'issue-move', issueId: 'A', projectId: 'p1' }}
        >
          A
        </KanbanCard>
        <KanbanCard
          source={{ kind: 'issue-move', issueId: 'B', projectId: 'p1' }}
        >
          B
        </KanbanCard>
      </DragSourceProvider>,
    );
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>('[data-dnd-card]'),
    );
    expect(cards).toHaveLength(2);
    const [a, b] = cards;
    expect(a!.getAttribute('data-dnd-card-issue-id')).toBe('A');
    expect(b!.getAttribute('data-dnd-card-issue-id')).toBe('B');
    expect(a!.className).toContain('opacity-50');
    expect(b!.className).not.toContain('opacity-50');
  });

  it('no dim when no drag is active (DragSourceContext is null)', () => {
    const { container } = render(
      <DragSourceProvider value={null}>
        <KanbanCard
          source={{ kind: 'issue-move', issueId: 'A', projectId: 'p1' }}
        >
          A
        </KanbanCard>
      </DragSourceProvider>,
    );
    const card = container.querySelector('[data-dnd-card]')!;
    expect(card.className).not.toContain('opacity-50');
  });
});
