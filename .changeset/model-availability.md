---
"lgtmoose": patch
---

Check that the configured models can be called before the first review. `lgtmoose deploy` checks every pinned model and warns, naming the provider, tiers, model ID, region and fix, but still deploys. It checks Bedrock inference profiles and model IDs, model access and agreements in the deploy region, and API keys against `GET /v1/models/<model>` on the Anthropic and OpenAI APIs. The 6-hourly health check asks Bedrock again, with a role that may only describe the pinned models, and sets the new `ModelUnavailable` metric with a `ModelAlarm-<provider>` alarm. Under docker compose it checks API-key models too. Aliases, ARNs, Vertex, Cursor and subscription sign-ins aren't checked.
