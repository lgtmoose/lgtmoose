---
id: tenant-scoping
title: Multi-tenant API scoping
description: >-
  Example private pack for an API whose data belongs to organisations, their locations and their
  consumers. Copy it into packages/roles/rulepacks/private/ and adjust the names to your schema.
rules:
  - id: org-filter
    category: tenant_scoping
    severity: blocking
    rule: A query that reads or changes tenant data by ID without also filtering on the caller's organisation.
    example: |
      const order = await db.orders.findOne({ id: req.params.id });
      // should be { id: req.params.id, orgId: req.auth.orgId }
  - id: org-from-request
    category: tenant_scoping
    severity: blocking
    rule: The organisation or location taken from the request body, query or path instead of the authenticated session.
    example: |
      const orgId = req.body.orgId;
  - id: location-access
    category: tenant_scoping
    severity: blocking
    rule: A staff endpoint that works on a location without checking that the caller has access to that location, not just to its organisation.
    example: |
      await db.shifts.update({ id, locationId: req.params.locationId }, changes); // no canAccessLocation()
  - id: consumer-isolation
    category: tenant_scoping
    severity: blocking
    rule: A consumer-facing endpoint that returns or changes another consumer's records, such as orders, payment methods or bookings.
    example: |
      return db.bookings.find({ locationId }); // missing consumerId: req.auth.consumerId
  - id: cross-tenant-reference
    category: tenant_scoping
    severity: blocking
    rule: A join, include or lookup that follows IDs from the request into rows without re-checking that they belong to the caller's organisation.
    example: |
      const items = await db.menuItems.find({ id: { in: body.itemIds } }); // ids can be another org's
  - id: background-job-scope
    category: tenant_scoping
    severity: should_fix
    rule: A job or webhook handler that processes tenant data without carrying and checking the organisation it was queued for.
    example: |
      queue.process("export", async ({ exportId }) => runExport(exportId)); // org not checked
  - id: admin-bypass
    category: authz
    severity: blocking
    rule: A support or super-admin path that skips tenant filters without an explicit, audited permission check.
    example: |
      if (req.headers["x-support"]) return db.orders.find({});
---

Use these rules for code that reads or writes organisation, location or consumer data.
