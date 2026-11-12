// The call graph of a Yul object and its cycles. Both "spill" compiler bugs
// (UnsoundSpillInMutualRecursion, SpillSlotCollisionAcrossMutualRecursion)
// need a cycle of at least two mutually recursive functions. The callers
// read the graph twice: from the unoptimized IR (every function the
// contract has) and from the optimized IR (the code the stack-to-memory
// mover, where both bugs sit, works on).

/** The IR without comments and string literals (both can hold braces and quotes), in one pass. */
export function strip(code) {
  const out = [];
  let i = 0;
  let from = 0;
  const n = code.length;
  while (i < n) {
    const ch = code.charCodeAt(i);
    if (ch === 34 /* " */) {
      out.push(code.slice(from, i), '""');
      i++;
      while (i < n && code.charCodeAt(i) !== 34) i += code.charCodeAt(i) === 92 ? 2 : 1;
      i++;
      from = i;
    } else if (ch === 47 /* / */ && code.charCodeAt(i + 1) === 47) {
      out.push(code.slice(from, i));
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      from = i;
    } else if (ch === 47 && code.charCodeAt(i + 1) === 42) {
      out.push(code.slice(from, i), " ");
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      from = i;
    } else i++;
  }
  out.push(code.slice(from));
  return out.join("");
}

/** Function definitions of one Yul object's code (already stripped), with the functions each calls. */
export function callGraph(code) {
  const defs = new Map();
  const re = /\bfunction\s+([A-Za-z_$][\w$.]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    // Body: from the first "{" after the signature to its matching "}".
    const i = code.indexOf("{", m.index);
    if (i === -1) break;
    let depth = 0;
    let j = i;
    for (; j < code.length; j++) {
      const ch = code.charCodeAt(j);
      if (ch === 123) depth++;
      else if (ch === 125) {
        depth--;
        if (depth === 0) break;
      }
    }
    defs.set(m[1], code.slice(i, j + 1));
    // Yul has no nested function definitions in this IR: continue after the body.
    re.lastIndex = j + 1;
  }
  const graph = new Map();
  for (const [name, body] of defs) {
    const calls = new Set();
    for (const c of body.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)) if (defs.has(c[1])) calls.add(c[1]);
    graph.set(name, calls);
  }
  return graph;
}

/** Tarjan: strongly connected components with more than one function, and self-recursive functions. */
export function cycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const sccs = [];
  const visit = (v) => {
    // Iterative, the graphs are deep.
    const work = [[v, [...graph.get(v)], 0]];
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, edges] = frame;
      if (frame[2] < edges.length) {
        const w = edges[frame[2]++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          on.add(w);
          work.push([w, [...graph.get(w)], 0]);
        } else if (on.has(w)) low.set(node, Math.min(low.get(node), idx.get(w)));
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(node)));
        }
        if (low.get(node) === idx.get(node)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            on.delete(w);
            comp.push(w);
          } while (w !== node);
          if (comp.length > 1) sccs.push(comp);
        }
      }
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  const self = [...graph].filter(([n, c]) => c.has(n)).map(([n]) => n);
  return { sccs, self };
}

/** The code of each Yul object of a contract's IR (a contract has its creation and its runtime object, and one more per contract it creates). */
export const yulObjects = (ir) =>
  strip(ir)
    .split(/\bobject\s+""/)
    .slice(1);

/** The recursion of every Yul object of a contract's IR (unoptimized or optimized), summed. */
export function recursion(ir) {
  const names = [...ir.matchAll(/\bobject\s+"([^"]+)"/g)].map((m) => m[1]);
  const result = { objects: 0, functions: 0, calls: 0, mutual: [], self: [] };
  for (const [n, part] of yulObjects(ir).entries()) {
    const graph = callGraph(part);
    result.objects += 1;
    result.functions += graph.size;
    for (const callees of graph.values()) result.calls += callees.size;
    const { sccs, self } = cycles(graph);
    for (const scc of sccs) result.mutual.push(`[${names[n] ?? `object ${n}`}] ${scc.join(" <-> ")}`);
    for (const name of self) result.self.push(`[${names[n] ?? `object ${n}`}] ${name}`);
  }
  return result;
}

/**
 * Did the compiler move any stack variable to memory in this build? Both
 * spill bugs sit in that mover and can only show where it acted. Every Yul
 * object starts its free memory at memoryguard(<literal>): 0x80, plus one
 * word per immutable in creation code. The mover reserves its slots by
 * raising that literal, so a literal that is higher in the optimized IR
 * than in the unoptimized IR of the same object means variables were moved.
 */
export function memoryMoved(ir, irOptimized) {
  const guards = (code) => [...code.matchAll(/memoryguard\((0x[0-9a-f]+|\d+)\)/g)].map((m) => Number(m[1]));
  const before = guards(ir);
  const after = guards(irOptimized);
  // The optimizer may drop an object's guard with the code that used it; then the highest values are compared (errs towards "moved").
  const moved = before.length === after.length ? after.some((g, i) => g > before[i]) : Math.max(0, ...after) > Math.max(0, ...before);
  const hex = (list) => list.map((g) => `0x${g.toString(16)}`).join(", ");
  return {
    moved,
    text: moved
      ? `memoryguard ${hex(before)} became ${hex(after)}: variables WERE moved to memory`
      : `memoryguard ${hex(after)} as in the unoptimized IR: nothing moved to memory`,
  };
}

/**
 * The search must find recursion where there is some: a planted case, with
 * braces and quotes inside a comment and a string to trip a careless reader.
 * Exits the process when it is not found.
 */
export function assertSearchWorks() {
  const planted =
    'object "T" { code { /** @src "x { y" */ function a(x) -> r { r := b(x) } // } {\n function b(x) -> r { let s := "}{" r := c(x) } ' +
    "function c(x) -> r { r := a(x) } function d(x) -> r { r := d(x) } function e() { let q := add(1, 2) } } }";
  const { sccs, self } = cycles(callGraph(yulObjects(planted)[0]));
  const ok = sccs.length === 1 && sccs[0].slice().sort().join() === "a,b,c" && self.join() === "d";
  console.log(`Planted case (a -> b -> c -> a, d -> d, e plain): ${ok ? "found as expected" : "NOT FOUND, the search is broken"}`);
  if (!ok) process.exit(1);
}
