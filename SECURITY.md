# Security policy

## Status

**mobile-cc is early-stage software.** Reports are handled on a best-effort
basis — there is no formal SLA. Use at your own risk; if your threat model
requires a tool with paid incident response, mobile-cc is not the right
choice yet.

## Reporting a vulnerability

Use GitHub's [Security Advisories](https://github.com/eyalev/mobile-cc/security/advisories/new)
on the repo's Security tab — that's the preferred channel; it's private,
structured, and threads with any later CVE. Email **eyalev@gmail.com**
with `[mobile-cc security]` in the subject also works.

Please include:

- mobile-cc version (`mobile-cc --version`).
- Operating system + distro.
- A minimal reproducer or proof-of-concept.
- Whether you've reported the same issue to the upstream ttyview project (most
  of mobile-cc's surface is `ttyview-core`, so a real vulnerability often
  belongs there).

Please **do not** open public GitHub issues for security problems before
they're addressed.

## In scope

- Authentication / authorisation bypass in any future auth mechanism mobile-cc
  ships.
- Remote code execution in the daemon (axum/tokio surface, plugin loading,
  upload handling once that lands in v0.2).
- Plugin sandbox escape, once a sandbox exists. (Plugins are eval'd in the
  page today — this is documented and the platform shape is still stabilising.)
- Information leak via the diagnostic JSONL writer or the plugin source
  endpoints (e.g., serving files outside the plugin dir).
- Path traversal in any endpoint that takes a filename / id.
- Anything that lets a remote party send keystrokes to a tmux session
  belonging to a user who didn't authorise it, **assuming the operator did not
  explicitly enable public bind**.

## Out of scope (by design — not bugs)

- **Anyone who reaches the bound port can drive the tmux session.** mobile-cc
  has no built-in authentication. The deployment model is "bind to 127.0.0.1
  and tunnel to your phone via Tailscale / ssh -L / cloudflared tunnel".
  Public-bind requires explicit opt-in via `--allow-public-bind` plus the
  `MOBILE_CC_I_UNDERSTAND_THE_RISKS=1` environment variable; using these and
  then getting compromised is an operator decision, not a vulnerability.
- Resource-exhaustion DoS against an unauthenticated public-bind deployment.
  Same reasoning.
- Issues that require the attacker to already be authenticated as the user
  running mobile-cc (e.g., local privilege escalation against the same UID's
  files).
- Issues in `tmux`, the OS, the user's reverse proxy, or third-party plugins.

## Response expectations

Best-effort, no fixed cadence:

| Action | Typical target |
|---|---|
| Acknowledge receipt | within a week |
| Initial assessment + scope decision | within 2 weeks |
| Patch / mitigation for in-scope issues | next release cycle |
| Public advisory after fix | as part of the release notes |

If an issue is severe and you need to protect a running deployment
immediately, the reliable mitigation is to stop the daemon
(`systemctl --user stop mobile-cc`) and uninstall (`rm ~/.local/bin/mobile-cc`)
until a fix lands — the same kill switch the maintainer has.

## No bounty programme

mobile-cc is a personal project. There is no money on the table. Credit in the
release notes is offered for in-scope reports if the reporter wants it.

## Upstream

mobile-cc is a thin packaging of [`ttyview-core`](https://github.com/ttyview/ttyview).
The vast majority of the attack surface (HTTP/WS routes, plugin loader, tmux
control-mode source, parser) lives upstream. If a vulnerability is in the
shared library code, both projects need to coordinate. Reports about clearly
upstream surfaces are routed there.
