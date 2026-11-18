---
"lgtmoose": patch
---

Imported secrets are read by name. A partial ARN whose name ends in a hyphen and six characters is resolved as a different secret, which made every webhook fail before its signature was checked. A provider id that would produce such a name is refused for the sandbox, which can only be given an ARN.
