---
id: generic
title: Generic
description: Rules for any language and any repo. Always on.
rules:
  - id: wrong-logic
    category: correctness
    severity: blocking
    rule: Wrong logic, such as an inverted or incomplete condition, an off-by-one error, the wrong operator or the wrong variable.
    example: |
      if (items.length > 0) return "empty";
  - id: unhandled-case
    category: correctness
    severity: blocking
    rule: A case the code clearly receives is not handled, such as an empty list, a missing key, null or undefined, zero or a negative number.
    example: |
      const first = users[0].name; // users can be empty
  - id: async-mistake
    category: correctness
    severity: blocking
    rule: A promise that is not awaited, work that runs in the wrong order, or shared state changed by concurrent calls.
    example: |
      save(record); // returns a promise; the next line reads the saved record
  - id: broken-callers
    category: correctness
    severity: blocking
    rule: A changed signature, return type or behaviour that existing callers still rely on. Read the callers to check.
    example: |
      // parse() now returns undefined on bad input, but callers still call .value on it
  - id: resource-leak
    category: correctness
    severity: should_fix
    rule: A file, connection, timer or listener that is opened and never closed.
    example: |
      const handle = await open(path); // no close on any path
  - id: data-loss
    category: correctness
    severity: blocking
    rule: A write that overwrites, truncates or deletes more than intended.
    example: |
      await db.delete(orders); // no where clause
  - id: swallowed-error
    category: error_handling
    severity: should_fix
    rule: An error that is caught and ignored, or logged and then treated as success.
    example: |
      try { await charge(); } catch {} return { ok: true };
  - id: unhandled-failure
    category: error_handling
    severity: should_fix
    rule: A call that can fail (network, file system, parsing, external processes) with no handling where a failure is likely.
    example: |
      const config = JSON.parse(await readFile(path, "utf8")); // user-edited file
  - id: lossy-error-message
    category: error_handling
    severity: should_fix
    rule: An error message that drops the cause, or that leaks secrets or internal details to users.
    example: |
      res.status(500).send(error.stack);
  - id: cleanup-on-error
    category: error_handling
    severity: should_fix
    rule: Cleanup that does not run on the error path.
    example: |
      const dir = await mkdtemp(prefix); await work(dir); await rm(dir); // no finally
  - id: unsafe-retry
    category: error_handling
    severity: should_fix
    rule: Retries with no limit, or retries of an operation that is not safe to repeat.
    example: |
      while (!(await send(payment))) {}
  - id: injection
    category: security
    severity: blocking
    rule: User input built into SQL, shell commands, file paths, HTML, regular expressions or templates without escaping or parameters.
    example: |
      db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  - id: unvalidated-input
    category: security
    severity: should_fix
    rule: Untrusted input (request bodies, headers, webhook payloads, file contents) that is not validated before use.
    example: |
      const amount = req.body.amount; // used as a number, never checked
  - id: unsafe-eval
    category: security
    severity: blocking
    rule: Unsafe deserialization, or eval and similar functions on input.
    example: |
      const fn = new Function(req.query.code);
  - id: path-traversal
    category: security
    severity: blocking
    rule: User input that can reach files outside the intended folder.
    example: |
      res.sendFile(join(uploads, req.params.name)); // name can be ../../etc/passwd
  - id: weak-crypto
    category: security
    severity: blocking
    rule: Home-made crypto, hard-coded keys or IVs, or a non-constant-time comparison of secrets.
    example: |
      if (req.headers["x-signature"] === expected) { … }
  - id: tls-disabled
    category: security
    severity: blocking
    rule: TLS or certificate checks turned off.
    example: |
      new https.Agent({ rejectUnauthorized: false });
  - id: missing-check
    category: authz
    severity: blocking
    rule: A new route, handler or action with no authentication or permission check, where similar code has one.
    example: |
      router.delete("/users/:id", deleteUser); // other routes use requireAdmin
  - id: wrong-subject
    category: authz
    severity: blocking
    rule: A check against the wrong user, role or tenant, or a check the caller can skip.
    example: |
      if (req.query.admin === "true") return next();
  - id: cross-user-access
    category: authz
    severity: blocking
    rule: Data from one user or tenant that another can read or change.
    example: |
      return db.invoices.find({ id: req.params.id }); // no owner filter
  - id: committed-secret
    category: secrets
    severity: blocking
    rule: Credentials, tokens, keys or passwords committed in code, config or test fixtures.
    example: |
      const STRIPE_KEY = "sk_live_…";
  - id: leaked-secret
    category: secrets
    severity: blocking
    rule: A secret written to logs, error messages, URLs or responses.
    example: |
      log.info("connecting", { url, password });
  - id: missing-test
    category: tests
    severity: should_fix
    rule: New behaviour or a bug fix with no test, in a repo that has tests for similar code.
    example: |
      // adds a refund path to payments.ts; payments.test.ts covers only charges
  - id: test-cannot-fail
    category: tests
    severity: should_fix
    rule: A test that cannot fail, such as one with no assertions, one that asserts on the mock itself, or one that is skipped.
    example: |
      it("refunds", async () => { await refund(order); });
  - id: test-matches-bug
    category: tests
    severity: should_fix
    rule: A test changed to match a bug instead of the intended behaviour.
    example: |
      expect(total([1, 2])).toBe(4); // was 3
  - id: flaky-test
    category: tests
    severity: should_fix
    rule: A test that depends on the clock, the network, random values or run order without controlling them.
    example: |
      expect(token.expiresAt).toBe(Date.now() + 3600_000);
  - id: unused-new-code
    category: wiring
    severity: should_fix
    rule: A new module, function or component that nothing imports or calls, when the PR means to use it.
    example: |
      // adds validateOrder() but the handler still calls the old check
  - id: missing-export
    category: wiring
    severity: should_fix
    rule: A new export left out of the package's index or public entry point.
    example: |
      // packages/core/src/money.ts exports formatCents; index.ts doesn't re-export it
  - id: unregistered-handler
    category: wiring
    severity: should_fix
    rule: A new route, command, job or handler that is never registered.
    example: |
      // adds jobs/cleanup.ts; the scheduler's job list is unchanged
  - id: undeclared-setting
    category: wiring
    severity: should_fix
    rule: A new environment variable or setting that is read but not added to the config schemas, examples, deployment files or docs that list the others.
    example: |
      const limit = Number(process.env.EXPORT_LIMIT); // not in .env.example or the schema
  - id: stale-reference
    category: wiring
    severity: blocking
    rule: A renamed or removed export, setting or environment variable that is still used somewhere else.
    example: |
      // renames getUser to fetchUser; admin/page.tsx still imports getUser
  - id: missing-dependency
    category: wiring
    severity: should_fix
    rule: A new dependency that is used but not added to the package manifest, or added to the wrong package.
    example: |
      import { z } from "zod"; // zod is only in the root package.json
---

Report a finding only when the diff breaks one of these rules, or a rule in another rule pack or in the repo's convention files.

Report a security problem under `authz` or `secrets` instead of `security` when one of them fits better.

For the wiring rules, read the files around the change to check that new code is connected to the rest of the system.
