# Private rule packs

Put your own rule packs here, one `<id>.md` file each, in the same format as the built-in packs
one folder up. Repos then turn them on by id in `.lgtmoose.yaml`:

```yaml
rulepacks: [typescript, tenant-scoping]
```

This folder ships in the control image with the built-in packs, so a fork can add packs without
changing any code. An id can't reuse a built-in pack's id. See `docs/rule-packs.md`, and
`examples/rulepacks/` for an example.
