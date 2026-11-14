---
id: security
title: Security
description: Security rules beyond the generic pack, for any language. Always on.
rules:
  - id: ssrf
    category: security
    severity: blocking
    rule: A server-side request to a URL or host the user controls, with no allowlist, so it can reach internal services or cloud metadata.
    example: |
      const res = await fetch(req.body.webhookUrl);
  - id: xss
    category: security
    severity: blocking
    rule: User content rendered as HTML without escaping, or passed to an API that interprets HTML or script.
    example: |
      element.innerHTML = comment.body;
  - id: open-redirect
    category: security
    severity: should_fix
    rule: A redirect to a URL taken from the request, with no check that it stays on an allowed host.
    example: |
      res.redirect(req.query.next);
  - id: mass-assignment
    category: authz
    severity: blocking
    rule: A request body copied into a record whole, so a caller can set fields they shouldn't, such as role, owner or price.
    example: |
      await db.users.update(id, req.body);
  - id: csrf
    category: security
    severity: should_fix
    rule: A state-changing endpoint that relies on cookies for authentication with no CSRF protection or SameSite cookie.
    example: |
      app.post("/account/email", session(), changeEmail); // cookie auth, no token
  - id: insecure-cookie
    category: security
    severity: should_fix
    rule: A session or auth cookie set without Secure, HttpOnly or a SameSite attribute.
    example: |
      res.cookie("session", token);
  - id: weak-randomness
    category: security
    severity: blocking
    rule: Math.random or another non-cryptographic generator used for tokens, IDs that must be unguessable, or keys.
    example: |
      const resetToken = Math.random().toString(36).slice(2);
  - id: token-expiry
    category: security
    severity: should_fix
    rule: A token, invite or reset link with no expiry, or one that stays valid after it is used or revoked.
    example: |
      await db.resetTokens.insert({ userId, token }); // no expiresAt, never deleted
  - id: sensitive-logging
    category: security
    severity: should_fix
    rule: Personal or payment data written to logs or analytics, such as email addresses, phone numbers, card numbers or whole request bodies. Credentials, passwords and tokens in logs are generic's leaked-secret instead (secrets, blocking).
    example: |
      logger.info("checkout", { email: user.email, card: body.cardNumber });
  - id: unsafe-file-upload
    category: security
    severity: blocking
    rule: An upload stored or served with a name, type or location the user controls, or with no size limit.
    example: |
      await writeFile(join(publicDir, file.originalname), file.buffer);
  - id: verbose-errors
    category: security
    severity: should_fix
    rule: Stack traces, SQL or internal hostnames returned to API clients.
    example: |
      catch (error) { res.status(500).json({ error: String(error), query }); }
  - id: missing-rate-limit
    category: security
    severity: should_fix
    rule: A login, password reset, OTP or other guessable endpoint added with no rate limit, where similar endpoints have one.
    example: |
      router.post("/otp/verify", verifyOtp); // /login uses rateLimit()
---

Use these together with the generic pack. Prefer the more specific rule when both fit, except that a credential, password or token in a log, error, URL or response is always leaked-secret (secrets, blocking).
