---
id: typescript
title: TypeScript
description: Rules for TypeScript and JavaScript code.
rules:
  - id: unsafe-cast
    category: correctness
    severity: should_fix
    rule: A type assertion (as, !, as unknown as) that hides a value the code doesn't check, such as parsed JSON, an API response or a possibly missing element.
    example: |
      const user = JSON.parse(body) as User;
  - id: any-leak
    category: correctness
    severity: should_fix
    rule: An explicit any, or an untyped dependency, that lets unchecked values flow into typed code the PR adds.
    example: |
      function total(items: any) { return items.reduce((a, b) => a + b.price, 0); }
  - id: floating-promise
    category: correctness
    severity: blocking
    rule: A promise that is neither awaited, returned nor given a rejection handler, so failures are lost or the order is wrong.
    example: |
      items.forEach(async (item) => { await save(item); }); // forEach doesn't wait
  - id: falsy-zero
    category: correctness
    severity: should_fix
    rule: A truthiness check or || default that treats 0, "" or false as missing.
    example: |
      const limit = options.limit || 50; // limit: 0 becomes 50
  - id: equality
    category: correctness
    severity: nit
    rule: Loose equality (== or !=) where the operands can have different types, outside an intentional == null check.
    example: |
      if (status == 0) { … }
  - id: non-exhaustive-switch
    category: correctness
    severity: should_fix
    rule: A switch or if-chain over a union or enum that misses a member, with no exhaustiveness check, when the PR adds a member.
    example: |
      type Status = "open" | "closed" | "archived"; // switch(status) handles two
  - id: mutated-argument
    category: correctness
    severity: should_fix
    rule: A function that changes an array or object it was given, when callers don't expect it to.
    example: |
      function sorted(list: number[]) { return list.sort(); }
  - id: date-handling
    category: correctness
    severity: should_fix
    rule: Dates parsed or compared as strings, built from local time where UTC is meant, or months off by one.
    example: |
      new Date(2026, 11, 1); // December, not November
---
