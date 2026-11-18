---
"lgtmoose": patch
---

The gateway reads the webhook secret by its name. The ARN of a secret imported by name has no random suffix, and Secrets Manager rejects that, so every webhook came back as an internal error.
