---
id: node-api
title: Node.js APIs
description: Rules for Node.js HTTP APIs, workers and database code.
rules:
  - id: unvalidated-body
    category: security
    severity: should_fix
    rule: A handler that uses the request body, query or params without a schema check (zod, joi or similar), where other handlers validate.
    example: |
      router.post("/orders", async (req, res) => { await createOrder(req.body); });
  - id: missing-transaction
    category: correctness
    severity: blocking
    rule: Several writes that must succeed or fail together, done outside a transaction.
    example: |
      await db.accounts.debit(from, amount);
      await db.accounts.credit(to, amount);
  - id: n-plus-one
    category: correctness
    severity: should_fix
    rule: A query run once per item in a loop, where one query or a batch would do.
    example: |
      for (const order of orders) order.items = await db.items.find({ orderId: order.id });
  - id: unbounded-query
    category: correctness
    severity: should_fix
    rule: A list endpoint or query with no limit or pagination over a table that can grow.
    example: |
      return db.events.find({ orgId });
  - id: idempotency
    category: money
    severity: blocking
    rule: A payment, charge, refund or other side effect that runs twice when the request or job is retried, with no idempotency key or check.
    example: |
      await stripe.charges.create({ amount, customer }); // retried by the queue on failure
  - id: amount-units
    category: money
    severity: blocking
    rule: Amounts mixed between units (cents and dollars, minor and major units) or stored as floating point.
    example: |
      await charge({ amount: order.total }); // total is in dollars, API expects cents
  - id: blocking-call
    category: correctness
    severity: should_fix
    rule: A synchronous file, crypto or child-process call on a request path.
    example: |
      const data = fs.readFileSync(path); // inside a request handler
  - id: missing-timeout
    category: error_handling
    severity: should_fix
    rule: An outbound HTTP call or database query with no timeout, on a path a user waits for.
    example: |
      const res = await fetch(partnerUrl);
  - id: status-codes
    category: correctness
    severity: nit
    rule: A response status that doesn't match what happened, such as 200 for a failure or 500 for bad input.
    example: |
      if (!valid) return res.status(200).json({ error: "invalid" });
  - id: nosql-injection
    category: security
    severity: blocking
    rule: A request value passed into a database query object, so a caller can send an operator such as $ne or $gt instead of a value.
    example: |
      db.users.findOne({ email: req.body.email, password: req.body.password });
---
