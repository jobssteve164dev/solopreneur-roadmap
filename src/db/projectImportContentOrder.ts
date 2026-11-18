// Return dependency components before their users without recursive JS frames.
export function projectImportContentOrder(ids: readonly string[], references: ReadonlyMap<string, readonly string[]>): string[][] {
  const known = new Set(ids), reverse = new Map(ids.map(id => [id, [] as string[]]));
  const edges = new Map(ids.map(id => [id, (references.get(id) || []).filter(target => known.has(target))]));
  for (const [id, targets] of edges) for (const target of targets) reverse.get(target)!.push(id);
  const visited = new Set<string>(), finished: string[] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack = [{ id, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1], targets = edges.get(frame.id)!;
      if (frame.next < targets.length) {
        const target = targets[frame.next++];
        if (!visited.has(target)) { visited.add(target); stack.push({ id: target, next: 0 }); }
      } else { finished.push(frame.id); stack.pop(); }
    }
  }
  visited.clear();
  const components: string[][] = [];
  for (let index = finished.length - 1; index >= 0; index--) {
    const id = finished[index];
    if (visited.has(id)) continue;
    const component: string[] = [], stack = [id];
    visited.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const target of reverse.get(current)!) if (!visited.has(target)) { visited.add(target); stack.push(target); }
    }
    components.push(component);
  }
  return components.reverse();
}
