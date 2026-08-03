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
        simpleId: 'PROJ-1',
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
    render(
      <CardNodeRow node={cardNode().node} style={{}} activeIssueId="issue-1" />,
    );

    const row = screen.getByRole('treeitem');
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className).toContain('font-semibold');
  });

  it('activates a leaf card when its row is clicked', () => {
    const { node, activate } = cardNode();
    render(<CardNodeRow node={node} style={{}} />);

    fireEvent.click(screen.getByRole('treeitem'));

    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('shows an isolated caret toggle for cards with sub-issues', () => {
    const child = cardNode({ id: 'issue-2', simpleId: 'PROJ-2' }).node.data;
    const { node, activate, toggle } = cardNode({}, [child], true);
    const { container } = render(<CardNodeRow node={node} style={{}} />);

    const row = screen.getByRole('treeitem');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it('renders leaf cards without a caret or aria-expanded', () => {
    const { node, activate } = cardNode();
    const { container } = render(<CardNodeRow node={node} style={{}} />);

    const row = screen.getByRole('treeitem');
    expect(container.querySelector('button')).toBeNull();
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(row);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
