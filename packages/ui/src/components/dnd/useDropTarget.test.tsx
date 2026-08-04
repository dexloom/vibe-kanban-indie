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
  out,
}: {
  id: string;
  projectId: string;
  acceptKinds?: Parameters<typeof useDropTarget>[2] extends infer O
    ? O extends { acceptKinds?: infer A }
      ? A
      : never
    : never;
  out: { attrs: Record<string, string> | null };
}) {
  out.attrs = useDropTarget(id, projectId, { acceptKinds });
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
});
