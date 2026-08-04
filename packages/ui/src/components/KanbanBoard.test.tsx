/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KanbanCard, KanbanCards } from './KanbanBoard';
import {
  DragActiveProvider,
  DragCandidateProvider,
  DragSourceProvider,
} from './outliner/dragState';

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
      const clones = col.querySelectorAll(
        '[data-dnd-card-issue-id="issue-1"]'
      );
      expect(clones.length).toBe(1);
      expect((clones[0] as HTMLElement).style.opacity).toBe('0.5');
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
