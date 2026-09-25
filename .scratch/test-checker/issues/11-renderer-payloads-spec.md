# 11 — Template renderer, payloads and spec commands

**What to build:** Prompts render safely (unknown variables error, `{{#if}}` and variants work, `target.*` refused in writer/repair templates) into hashed, registered payloads. `spec prompt|save|show|edit` produce and store specs, rejecting specs that quote the body.

**Blocked by:** 10 — Leak check and `context set`

**Status:** done

- [ ] A spec quoting a body line is rejected
- [ ] Renderer refuses unknown variables
- [ ] Writer template cannot reference `target.*`
