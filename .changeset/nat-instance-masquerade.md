---
"lgtmoose": patch
---

The lean NAT instance is a t4g.micro with swap, and its boot script retries the iptables install and masquerades with `ip route`. A t4g.nano runs out of memory installing iptables, and Amazon Linux 2023 has no `route` command, so the default script never masquerades. The AWS smoke test looks for the dispatcher forwarding the comment, which is what a comment job does.
