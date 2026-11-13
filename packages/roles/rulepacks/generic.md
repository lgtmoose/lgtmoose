# Generic rule pack (v0)

Rules for any language and any repo. Each section below is named by its `rule_category` id. Report a finding only when the diff breaks one of these rules, or a rule in the repo's convention files.

## correctness

The change does not do what it is meant to do, or breaks something that worked.

- Wrong logic: inverted or incomplete conditions, off-by-one errors, wrong operator, wrong variable.
- Unhandled cases the code clearly receives: empty lists, missing keys, `null` or `undefined`, zero, negative numbers.
- Async mistakes: a promise that is not awaited, work that runs in the wrong order, shared state changed by concurrent calls.
- A changed function signature, return type or behaviour that existing callers still rely on. Read the callers to check.
- Resource leaks: files, connections, timers or listeners that are opened and never closed.
- Data loss: writes that overwrite, truncate or delete more than intended.

## error_handling

Failures must be handled or passed on, never hidden.

- Errors that are caught and ignored, or logged and then treated as success.
- Calls that can fail (network, file system, parsing, external processes) with no handling where a failure is likely.
- Error messages that drop the cause, or that leak secrets or internal details to users.
- Cleanup that does not run on the error path.
- Retries with no limit, or retries of operations that are not safe to repeat.

## security

Basic security problems. Use `authz` or `secrets` instead when they fit better.

- Injection: user input built into SQL, shell commands, file paths, HTML, regular expressions or templates without escaping or parameters.
- Untrusted input that is not validated before use: request bodies, headers, webhook payloads, file contents.
- Unsafe deserialization, or `eval` and similar on input.
- Path traversal: user input that can reach files outside the intended folder.
- Weak or misused crypto: home-made schemes, hard-coded keys or IVs, non-constant-time comparison of secrets.
- TLS or certificate checks turned off.

## authz

- A new route, handler or action with no authentication or permission check, where similar code has one.
- Checks against the wrong user, role or tenant, or checks that a caller can skip.
- Data from one user or tenant that another can read or change.

## secrets

- Credentials, tokens, keys or passwords committed in code, config or test fixtures.
- Secrets written to logs, error messages, URLs or responses.

## tests

- New behaviour or a bug fix with no test, in a repo that has tests for similar code.
- Tests that cannot fail: no assertions, assertions on the mock itself, or a test that is skipped.
- Tests changed to match a bug instead of the intended behaviour.
- Tests that depend on the clock, the network, random values or run order without control.

## wiring

New code must be connected to the rest of the system. Read the files around the change to check.

- A new module, function or component that nothing imports or calls, when the PR means to use it.
- A new export left out of the package's index or public entry point.
- A new route, command, job or handler that is never registered.
- A new environment variable or setting that is read but not added to config schemas, examples, deployment files or docs that list the others.
- A renamed or removed export, setting or environment variable still used somewhere else.
- A new dependency used but not added to the package manifest, or added to the wrong package.
