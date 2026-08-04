/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDropTarget } from './useDropTarget';

afterEach(cleanup);

function Harness({
  id,
  projectId,
  acceptKinds,
  statusId,
  out,
}: {
  id: string;
  projectId: string;
  acceptKinds?: Parameters<typeof useDropTarget>[2] extends infer O
    ? O extends { acceptKinds?: infer A }
      ? A
      : never
    : never;
  statusId?: string;
  out: { attrs: Record<string, string> | null };
}) {
  out.attrs = useDropTarget(id, projectId, { acceptKinds, statusId });
  return <div />;
}

describe('useDropTarget', () => {
  it('returns the three data attrs with the given id and project', () => {
    const out = { attrs: null as Record<string, string> | null };
    render(
      <Harness id="project-1:status:todo" projectId="project-1" out={out} />
    );
    expect(out.attrs).toEqual({
      'data-drop-target-id': 'project-1:status:todo',
      'data-drop-target-project': 'project-1',
      'data-drop-target-accept-kinds': 'issue-move',
    });
  });

  it('default acceptKinds serializes to "issue-move"', () => {
    const out = { attrs: null as Record<string, string> | null };
    render(<Harness id="t1" projectId="p1" out={out} />);
    expect(out.attrs!['data-drop-target-accept-kinds']).toBe('issue-move');
  });

  it('custom acceptKinds serializes to a comma-separated list', () => {
    const out = { attrs: null as Record<string, string> | null };
    render(
      <Harness
        id="t1"
        projectId="p1"
        acceptKinds={['issue-move', 'column-reorder']}
        out={out}
      />
    );
    expect(out.attrs!['data-drop-target-accept-kinds']).toBe(
      'issue-move,column-reorder'
    );
  });

  it('omits data-drop-target-status when statusId is not provided (column targets)', () => {
    const out = { attrs: null as Record<string, string> | null };
    render(<Harness id="status-uuid" projectId="p1" out={out} />);
    expect(out.attrs).not.toHaveProperty('data-drop-target-status');
  });

  it('sets data-drop-target-status when statusId is provided (card targets)', () => {
    const out = { attrs: null as Record<string, string> | null };
    render(
      <Harness id="issue-1" projectId="p1" statusId="status-A" out={out} />
    );
    expect(out.attrs!['data-drop-target-status']).toBe('status-A');
  });
});
