# Security

LGTMoose reads untrusted text (pull requests, comments, code) with a model, and holds credentials that can write to GitHub. It rests on one rule: the model only reads and returns JSON; plain code holds every credential and makes every decision.

- **[SECURITY.md](https://github.com/lgtmoose/lgtmoose/blob/main/SECURITY.md)** is the security policy: how to report a vulnerability, what's in scope, and the threat model. The threat model lists each threat with the control that handles it and the tests that prove it, and the risks that remain.
- **[Architecture: security controls](architecture.md#security-controls)** summarises the controls, including the prompt-injection detector.
- **[Learning](learning.md)** has the write policy for learnings, the main way an attacker could try to steer future reviews.
- **[Commands](commands.md)** says who may run each command, and who may clear a blocking finding.
- **[Providers](providers.md)** covers vendor terms, and why a required human approval should stay on protected branches.

## Reporting a vulnerability

Report it privately through the repository's **Security → Report a vulnerability** page on GitHub, not in a public issue. SECURITY.md has what to include and how fast to expect an answer.

## For operators

- Keep a required human approval on protected branches. LGTMoose's approval should be a signal, not the only gate: an injection the detector misses could still talk the reviewer into reporting nothing.
- Make the `LGTMoose` check run a required status check, so an open blocking finding blocks the merge.
- Prefer credentials made for automation: Amazon Bedrock, API keys, or Cursor service accounts. See [Providers](providers.md).
- The [AWS smoke test](smoke-test.md) deploys to a throwaway account and checks that webhooks are verified and reach the queue.
