import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import { Tree, type TreeApi } from 'react-arborist';
import { describe, expect, it } from 'vitest';

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = RO as never;

interface TestNode {
  id: string;
  children: TestNode[];
}

const nodes: TestNode[] = [
  { id: 'a', children: [] },
  { id: 'b', children: [] },
];

describe('react-arborist initialOpenState', () => {
  it('seeds open state only when the tree mounts', () => {
    const ref = createRef<TreeApi<TestNode>>();
    const { rerender } = render(
      <Tree
        ref={ref}
        data={nodes}
        initialOpenState={{ a: false, b: false }}
        openByDefault={false}
        width={100}
        height={200}
        disableEdit
      />
    );

    expect(ref.current?.get('a')?.isOpen).toBe(false);

    act(() => ref.current?.get('a')?.toggle());
    expect(ref.current?.get('a')?.isOpen).toBe(true);

    rerender(
      <Tree
        ref={ref}
        data={nodes}
        initialOpenState={{ a: true, b: false }}
        openByDefault={false}
        width={100}
        height={200}
        disableEdit
      />
    );

    expect(ref.current?.get('a')?.isOpen).toBe(true);
  });
});
