/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, KanbanCards } from './KanbanBoard';
import {
  DragActiveProvider,
  DragCandidateIndexProvider,
  DragCandidateProvider,
  DragSourceProvider,
} from './outliner/dragState';
import { DragControllerContext } from './dnd/DragContext';
import type { DragController } from './dnd/DragController';

afterEach(cleanup);

const SOURCE_A = {
  kind: 'issue-move' as const,
  issueId: 'issue-1',
  projectId: 'p1',
  statusId: 'status-A',
};
const SOURCE_B = {
  kind: 'issue-move' as const,
  issueId: 'issue-2',
  projectId: 'p1',
  statusId: 'status-A',
};
const SOURCE_C = {
  kind: 'issue-move' as const,
  issueId: 'issue-3',
  projectId: 'p1',
  statusId: 'status-B',
};

describe('KanbanCard drop target attrs', () => {
  it('exposes data-drop-target-id + project + status + accept-kinds for the drag controller', () => {
    const { container } = render(<KanbanCard source={SOURCE_A}>A</KanbanCard>);
    const card = container.querySelector('[data-dnd-card]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-drop-target-id')).toBe('issue-1');
    expect(card?.getAttribute('data-drop-target-project')).toBe('p1');
    expect(card?.getAttribute('data-drop-target-status')).toBe('status-A');
    expect(card?.getAttribute('data-drop-target-accept-kinds')).toBe(
      'issue-move'
    );
  });

  it('also keeps the data-dnd-card-issue-id for the source-card dimming context', () => {
    const { container } = render(<KanbanCard source={SOURCE_A}>A</KanbanCard>);
    expect(
      container
        .querySelector('[data-dnd-card]')
        ?.getAttribute('data-dnd-card-issue-id')
    ).toBe('issue-1');
  });
});

describe('KanbanCard during a drag (no ring/outline highlights)', () => {
  it('does NOT add ring or brand classes to the candidate card during a drag', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value="issue-1">
          <KanbanCard source={SOURCE_A}>A</KanbanCard>
        </DragCandidateProvider>
      </DragActiveProvider>
    );
    const card = container.querySelector('[data-dnd-card]')!;
    expect(card.className).not.toContain('ring-brand');
    expect(card.className).not.toContain('bg-brand/10');
    expect(card.className).not.toContain('ring-border-strong/40');
    expect(card.className).not.toContain('ring-1');
    expect(card.className).not.toContain('ring-2');
  });

  it('does NOT add ring/border classes to a non-candidate card during a drag', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value="issue-OTHER">
          <KanbanCard source={SOURCE_A}>A</KanbanCard>
        </DragCandidateProvider>
      </DragActiveProvider>
    );
    const card = container.querySelector('[data-dnd-card]')!;
    expect(card.className).not.toContain('ring-border-strong/40');
    expect(card.className).not.toContain('ring-1');
    expect(card.className).not.toContain('bg-brand/10');
  });
});

describe('KanbanCard source dim', () => {
  it('applies opacity-50 to the dragged source card; other cards stay opaque', () => {
    const { container } = render(
      <DragSourceProvider value="issue-1">
        <KanbanCard source={SOURCE_A}>A</KanbanCard>
        <KanbanCard source={SOURCE_B}>B</KanbanCard>
      </DragSourceProvider>
    );
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>('[data-dnd-card]')
    );
    expect(cards).toHaveLength(2);
    const [a, b] = cards;
    expect(a!.getAttribute('data-dnd-card-issue-id')).toBe('issue-1');
    expect(b!.getAttribute('data-dnd-card-issue-id')).toBe('issue-2');
    expect(a!.className).toContain('opacity-50');
    expect(b!.className).not.toContain('opacity-50');
  });

  it('no dim when no drag is active (DragSourceContext is null)', () => {
    const { container } = render(
      <DragSourceProvider value={null}>
        <KanbanCard source={SOURCE_A}>A</KanbanCard>
      </DragSourceProvider>
    );
    const card = container.querySelector('[data-dnd-card]')!;
    expect(card.className).not.toContain('opacity-50');
  });
});

describe('KanbanCards column drop target', () => {
  it('renders children directly when no drag is active', () => {
    const { container } = render(
      <KanbanCards id="col-1" activeProjectId="p1">
        <div data-dnd-card="" data-dnd-card-issue-id="a">
          A
        </div>
        <div data-dnd-card="" data-dnd-card-issue-id="b">
          B
        </div>
      </KanbanCards>
    );
    const col = container.firstElementChild!;
    expect(col.children.length).toBe(2);
  });

  it('exposes data-drop-target-id + project + accept-kinds for the controller (no data-drop-target-status — column marker)', () => {
    const { container } = render(
      <KanbanCards id="col-uuid" activeProjectId="p1">
        {null}
      </KanbanCards>
    );
    const col = container.firstElementChild!;
    expect(col.getAttribute('data-drop-target-id')).toBe('col-uuid');
    expect(col.getAttribute('data-drop-target-project')).toBe('p1');
    expect(col.getAttribute('data-drop-target-accept-kinds')).toBe(
      'issue-move'
    );
    expect(col.hasAttribute('data-drop-target-status')).toBe(false);
  });

  it('does NOT tint the column with bg-brand/5 when it is the candidate (placeholder replaces the tint)', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragCandidateProvider value="col-1">
          <KanbanCards id="col-1" activeProjectId="p1">
            {null}
          </KanbanCards>
        </DragCandidateProvider>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    expect(col.className).not.toContain('bg-brand/5');
  });
});

describe('KanbanCards same-column swap preview', () => {
  it('visually swaps source card A and target card B in rendered children when candidate is B', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragSourceProvider value="issue-1">
          <DragCandidateProvider value="issue-2">
            <KanbanCards id="status-A" activeProjectId="p1">
              <KanbanCard key="issue-1" source={SOURCE_A}>
                A
              </KanbanCard>
              <KanbanCard key="issue-2" source={SOURCE_B}>
                B
              </KanbanCard>
            </KanbanCards>
          </DragCandidateProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    const ids = Array.from(
      col.querySelectorAll<HTMLElement>('[data-dnd-card]')
    ).map((el) => el.getAttribute('data-dnd-card-issue-id'));
    expect(ids).toEqual(['issue-2', 'issue-1']);
  });

  it('keeps original order when no swap is in flight (no candidate set)', () => {
    const { container } = render(
      <DragActiveProvider value={false}>
        <KanbanCards id="status-A" activeProjectId="p1">
          <KanbanCard key="issue-1" source={SOURCE_A}>
            A
          </KanbanCard>
          <KanbanCard key="issue-2" source={SOURCE_B}>
            B
          </KanbanCard>
        </KanbanCards>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    const ids = Array.from(
      col.querySelectorAll<HTMLElement>('[data-dnd-card]')
    ).map((el) => el.getAttribute('data-dnd-card-issue-id'));
    expect(ids).toEqual(['issue-1', 'issue-2']);
  });

  it('does NOT swap when the candidate is the column itself (cross-column move scenario)', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragSourceProvider value="issue-1">
          <DragCandidateProvider value="status-B">
            <KanbanCards id="status-A" activeProjectId="p1">
              <KanbanCard key="issue-1" source={SOURCE_A}>
                A
              </KanbanCard>
              <KanbanCard key="issue-2" source={SOURCE_B}>
                B
              </KanbanCard>
            </KanbanCards>
          </DragCandidateProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    const ids = Array.from(
      col.querySelectorAll<HTMLElement>('[data-dnd-card]')
    ).map((el) => el.getAttribute('data-dnd-card-issue-id'));
    expect(ids).toEqual(['issue-1', 'issue-2']);
  });
});

describe('KanbanCards cross-column move preview', () => {
  it('appends a dimmed clone of the dragged card when this column is the candidate', async () => {
    const { container, unmount } = render(
      <>
        <div data-dnd-card data-dnd-card-issue-id="issue-1">
          A
        </div>
        <DragActiveProvider value={true}>
          <DragSourceProvider value="issue-1">
            <DragCandidateProvider value="status-B">
              <KanbanCards id="status-B" activeProjectId="p1">
                <KanbanCard key="issue-2" source={SOURCE_B}>
                  B
                </KanbanCard>
              </KanbanCards>
            </DragCandidateProvider>
          </DragSourceProvider>
        </DragActiveProvider>
      </>
    );
    await waitFor(() => {
      const col = container.querySelector('[data-drop-target-id="status-B"]')!;
      const clones = Array.from(col.children).filter(
        (el) => (el as HTMLElement).style.opacity === '0.5'
      );
      expect(clones).toHaveLength(1);
      expect(clones[0]!.hasAttribute('data-dnd-card')).toBe(false);
      expect(clones[0]!.hasAttribute('data-dnd-card-issue-id')).toBe(false);
      expect(clones[0]!.hasAttribute('data-drop-target-id')).toBe(false);
      expect(clones[0]!.hasAttribute('data-drop-target-status')).toBe(false);
    });
    unmount();
  });

  it('inserts the dimmed clone at the candidate insertion index (not the end)', async () => {
    const { container, unmount } = render(
      <>
        <div data-dnd-card data-dnd-card-issue-id="issue-1">
          A
        </div>
        <DragActiveProvider value={true}>
          <DragSourceProvider value="issue-1">
            <DragCandidateProvider value="status-B">
              <DragCandidateIndexProvider value={0}>
                <KanbanCards id="status-B" activeProjectId="p1">
                  <KanbanCard key="issue-2" source={SOURCE_B}>
                    B
                  </KanbanCard>
                  <KanbanCard key="issue-3" source={SOURCE_C}>
                    C
                  </KanbanCard>
                </KanbanCards>
              </DragCandidateIndexProvider>
            </DragCandidateProvider>
          </DragSourceProvider>
        </DragActiveProvider>
      </>
    );
    await waitFor(() => {
      const col = container.querySelector('[data-drop-target-id="status-B"]')!;
      const order = Array.from(col.children).map(
        (el) => el.getAttribute('data-dnd-card-issue-id') ?? 'preview'
      );
      // index 0 → the clone goes BEFORE issue-2 / issue-3.
      expect(order).toEqual(['preview', 'issue-2', 'issue-3']);
    });
    unmount();
  });

  it('appends the clone when the candidate index is past the last child', async () => {
    const { container, unmount } = render(
      <>
        <div data-dnd-card data-dnd-card-issue-id="issue-1">
          A
        </div>
        <DragActiveProvider value={true}>
          <DragSourceProvider value="issue-1">
            <DragCandidateProvider value="status-B">
              <DragCandidateIndexProvider value={99}>
                <KanbanCards id="status-B" activeProjectId="p1">
                  <KanbanCard key="issue-2" source={SOURCE_B}>
                    B
                  </KanbanCard>
                </KanbanCards>
              </DragCandidateIndexProvider>
            </DragCandidateProvider>
          </DragSourceProvider>
        </DragActiveProvider>
      </>
    );
    await waitFor(() => {
      const col = container.querySelector('[data-drop-target-id="status-B"]')!;
      const order = Array.from(col.children).map(
        (el) => el.getAttribute('data-dnd-card-issue-id') ?? 'preview'
      );
      expect(order).toEqual(['issue-2', 'preview']);
    });
    unmount();
  });

  it('does NOT append a clone when the candidate is a card in this column (swap path)', async () => {
    const { container, unmount } = render(
      <DragActiveProvider value={true}>
        <DragSourceProvider value="issue-1">
          <DragCandidateProvider value="issue-2">
            <KanbanCards id="status-A" activeProjectId="p1">
              <KanbanCard key="issue-1" source={SOURCE_A}>
                A
              </KanbanCard>
              <KanbanCard key="issue-2" source={SOURCE_B}>
                B
              </KanbanCard>
            </KanbanCards>
          </DragCandidateProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    );
    await waitFor(() => {
      const col = container.querySelector('[data-drop-target-id="status-A"]')!;
      expect(
        col.querySelectorAll('[data-dnd-card-issue-id="issue-1"]').length
      ).toBe(1);
    });
    unmount();
  });

  it('does NOT append a clone when no drag is active', () => {
    const { container, unmount } = render(
      <KanbanCards id="status-A" activeProjectId="p1">
        <KanbanCard key="issue-1" source={SOURCE_A}>
          A
        </KanbanCard>
      </KanbanCards>
    );
    const col = container.querySelector('[data-drop-target-id="status-A"]')!;
    expect(
      col.querySelectorAll('[data-dnd-card-issue-id="issue-1"]').length
    ).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// P3-B1: positionalReorderEnabled gates BOTH same-column swap reorder and
// the cross-column insertion clone. Without the gate, priority/created_at/
// title sort shows a live swap that snap-back's on drop (commit is gated
// off in KanbanContainer but the preview leaked through). ADR-012 round-5
// §17.
// ---------------------------------------------------------------------------

describe('KanbanCards positionalReorderEnabled gating (P3-B1)', () => {
  it('does NOT reorder displayChildren when positionalReorderEnabled is false even with a peer candidate', () => {
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragSourceProvider value="issue-1">
          <DragCandidateProvider value="issue-2">
            <KanbanCards
              id="status-A"
              activeProjectId="p1"
              positionalReorderEnabled={false}
              issueIds={['issue-1', 'issue-2']}
            >
              <KanbanCard key="issue-1" source={SOURCE_A}>
                A
              </KanbanCard>
              <KanbanCard key="issue-2" source={SOURCE_B}>
                B
              </KanbanCard>
            </KanbanCards>
          </DragCandidateProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    const ids = Array.from(
      col.querySelectorAll<HTMLElement>('[data-dnd-card]')
    ).map((el) => el.getAttribute('data-dnd-card-issue-id'));
    // Original render order preserved — preview suppressed under
    // non-manual sort, so DOM matches what the backend will commit.
    expect(ids).toEqual(['issue-1', 'issue-2']);
  });

  it('still reorders when positionalReorderEnabled is omitted (defaults to true)', () => {
    // Backward-compat: callers that don't pass the new prop must keep
    // seeing the swap preview.
    const { container } = render(
      <DragActiveProvider value={true}>
        <DragSourceProvider value="issue-1">
          <DragCandidateProvider value="issue-2">
            <KanbanCards id="status-A" activeProjectId="p1">
              <KanbanCard key="issue-1" source={SOURCE_A}>
                A
              </KanbanCard>
              <KanbanCard key="issue-2" source={SOURCE_B}>
                B
              </KanbanCard>
            </KanbanCards>
          </DragCandidateProvider>
        </DragSourceProvider>
      </DragActiveProvider>
    );
    const col = container.firstElementChild!;
    const ids = Array.from(
      col.querySelectorAll<HTMLElement>('[data-dnd-card]')
    ).map((el) => el.getAttribute('data-dnd-card-issue-id'));
    expect(ids).toEqual(['issue-2', 'issue-1']);
  });

  it('does NOT append the cross-column clone when positionalReorderEnabled is false', async () => {
    const { container, unmount } = render(
      <>
        <div data-dnd-card data-dnd-card-issue-id="issue-1">
          A
        </div>
        <DragActiveProvider value={true}>
          <DragSourceProvider value="issue-1">
            <DragCandidateProvider value="status-B">
              <KanbanCards
                id="status-B"
                activeProjectId="p1"
                positionalReorderEnabled={false}
              >
                <KanbanCard key="issue-2" source={SOURCE_B}>
                  B
                </KanbanCard>
              </KanbanCards>
            </DragCandidateProvider>
          </DragSourceProvider>
        </DragActiveProvider>
      </>
    );
    // Give the effect a chance to run.
    await new Promise((res) => setTimeout(res, 0));
    const col = container.querySelector('[data-drop-target-id="status-B"]')!;
    const clones = Array.from(col.children).filter(
      (el) => (el as HTMLElement).style.opacity === '0.5'
    );
    expect(clones).toHaveLength(0);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// P3-B2: touch-action: none on every drag source. Without it the browser
// absorbs the gesture into scroll on touch and pointermove never reaches
// the controller. ADR-012 round-5 §17.
// ---------------------------------------------------------------------------

// Touch-action + drag binding only activates when the controller is
// mounted, so all assertions below render under a DragControllerContext
// that carries a stub controller. The stub is enough to make
// `useDraggable` return a non-null `onPointerDown` — we never call it.
const withController = (children: React.ReactNode) => {
  const controller = {
    startPress: vi.fn(),
  } as unknown as DragController;
  return (
    <DragControllerContext.Provider value={controller}>
      {children}
    </DragControllerContext.Provider>
  );
};

describe('KanbanCard touch-action: none (P3-B2)', () => {
  it('sets inline style.touchAction === "none" on the draggable root (desktop default)', () => {
    const { container } = render(
      withController(<KanbanCard source={SOURCE_A}>A</KanbanCard>)
    );
    const card = container.querySelector('[data-dnd-card]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.style.touchAction).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// P4-E1: on mobile, the drag binding + touch-action: none live on the
// `DotsSixVerticalIcon` handle (cursor-grab) so the card body stays
// scrollable by swipe. Desktop keeps whole-card binding (no scroll
// conflict, larger drag target).
// ---------------------------------------------------------------------------

describe('KanbanCard drag binding target (P4-E1)', () => {
  it('on mobile, the card root has NO touchAction: none and the handle div does', () => {
    const { container } = render(
      withController(
        <KanbanCard source={SOURCE_A} isMobile>
          A
        </KanbanCard>
      )
    );
    const card = container.querySelector('[data-dnd-card]') as HTMLElement;
    expect(card).toBeTruthy();
    // Card root: NO touch-action: none (so the card body can scroll).
    expect(card.style.touchAction).not.toBe('none');
    // Handle div: touch-action: none (sole touch target bound for drag).
    const handle = container.querySelector('.cursor-grab') as HTMLElement;
    expect(handle).toBeTruthy();
    expect(handle.style.touchAction).toBe('none');
  });

  it('on desktop, the card root has touchAction: none and there is no handle div', () => {
    const { container } = render(
      withController(<KanbanCard source={SOURCE_A}>A</KanbanCard>)
    );
    const card = container.querySelector('[data-dnd-card]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.style.touchAction).toBe('none');
    // Desktop: the mobile handle div is NOT rendered.
    expect(container.querySelector('.cursor-grab')).toBeNull();
  });
});
