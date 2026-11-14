---
id: react
title: React
description: Rules for React components and hooks.
rules:
  - id: hook-rules
    category: correctness
    severity: blocking
    rule: A hook called conditionally, in a loop or after an early return, so hooks run in a different order between renders.
    example: |
      if (!user) return null;
      const [open, setOpen] = useState(false);
  - id: missing-dependency
    category: correctness
    severity: should_fix
    rule: A useEffect, useMemo or useCallback that reads a value missing from its dependency list, so it uses a stale value.
    example: |
      useEffect(() => { load(orgId); }, []);
  - id: effect-cleanup
    category: correctness
    severity: should_fix
    rule: An effect that subscribes, starts a timer or fetches without cleanup, so it leaks or sets state after unmount.
    example: |
      useEffect(() => { const id = setInterval(poll, 1000); }, []);
  - id: unstable-key
    category: correctness
    severity: should_fix
    rule: A list rendered with array indexes or random values as keys when items can be reordered, added or removed.
    example: |
      {rows.map((row, i) => <Row key={i} row={row} />)}
  - id: state-mutation
    category: correctness
    severity: blocking
    rule: State or props changed in place instead of replaced, so React doesn't re-render.
    example: |
      items.push(item); setItems(items);
  - id: dangerous-html
    category: security
    severity: blocking
    rule: dangerouslySetInnerHTML with content that isn't sanitised.
    example: |
      <div dangerouslySetInnerHTML={{ __html: post.body }} />
  - id: derived-state
    category: correctness
    severity: nit
    rule: State copied from props or other state and kept in sync with an effect, where computing it during render would do.
    example: |
      useEffect(() => setFullName(`${first} ${last}`), [first, last]);
  - id: client-secret
    category: secrets
    severity: blocking
    rule: A secret or server-only key read in code that is bundled for the browser, such as through a public environment variable.
    example: |
      const key = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;
---
