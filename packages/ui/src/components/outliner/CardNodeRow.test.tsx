import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardNodeRow } from './CardNodeRow';
import type { CardNode } from './types';

afterEach(cleanup);

function cardNode(
  overrides: Partial<CardNode['issue']> = {},
  children: CardNode[] = [],
  isOpen = false,
) {
  const activate = vi.fn();
  const toggle = vi.fn();
  const node = {
    data: {
      id: 'issue-1',
      type: 'card',
      issue: {
        id: 'issue-1',
        title: 'Fix auth',
        priority: null,
        statusId: 'todo',
        projectId: 'project-1',
        parentIssueId: null,
        ...overrides,
      },
      children,
    },
    isOpen,
    activate,
    toggle,
    tree: { indent: 12 },
  } as unknown as NodeApi<CardNode>;
  return { node, activate, toggle };
}

describe('CardNodeRow', () => {
  it('renders the issue title', () => {
    const { container } = render(
      <CardNodeRow node={cardNode().node} style={{ paddingLeft: 36 }} />,
    );

    expect(container.textContent).toBe('Fix auth');
    expect(screen.getByText('Fix auth')).toBeTruthy();
  });

  it('marks the active issue as the current page with semibold text', () => {
    const { container } = render(
      <CardNodeRow node={cardNode().node} style={{}} activeIssueId="issue-1" />,
    );

    const row = container.firstElementChild as HTMLElement;
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className).toContain('font-semibold');
  });

  it('does not toggle or activate when a leaf card row is clicked', () => {
    // Navigation happens on react-arborist's OUTER row (handleActivate); the
    // inner row must not double-fire it.
    const { node, activate, toggle } = cardNode();
    const { container } = render(<CardNodeRow node={node} style={{}} />);

    fireEvent.click(container.firstElementChild as HTMLElement);

    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows an isolated caret toggle for cards with sub-issues', () => {
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node, activate, toggle } = cardNode({}, [child], true);
    const { container } = render(<CardNodeRow node={node} style={{}} />);

    const caret = container.querySelector('button') as HTMLButtonElement;
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-label')).toBe('Collapse');
    fireEvent.click(caret);

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it('renders leaf cards without a caret or aria-expanded', () => {
    const { node, activate, toggle } = cardNode();
    const { container } = render(<CardNodeRow node={node} style={{}} />);

    expect(container.querySelector('button')).toBeNull();
    expect(container.firstElementChild?.hasAttribute('aria-expanded')).toBe(
      false,
    );
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });
});
