# mobile-cc tutorials

Short, focused walkthroughs of mobile-cc. Start with installation, then dip
into individual features as you need them.

---

## 1. Installing mobile-cc

Run one command on the machine where Claude Code lives — it downloads and
**verifies** the binary, installs a systemd user service that keeps it
running, and prints the URL to open.

https://github.com/user-attachments/assets/e38891e6-946f-41db-b7de-c65f66f2a6b2

```bash
curl -fsSL https://mobile-cc.dev/install.sh | bash
```

That's the install itself. To actually drive Claude Code from your phone you
then expose it over Tailscale and open the URL — the full four-step flow
(including the tunnel) is in the main
[**Quickstart**](../../README.md#quickstart). Prefer a package manager or to
read the script before running it? See
[Install options](../../README.md#install-options).

> **Verifying what you install:** binaries come straight from GitHub Releases
> and `install.sh` checks them in order of strength — minisign signature, then
> GitHub build-provenance (SLSA) attestation, then SHA-256 — failing closed if
> none of the three can be checked. There's also a Homebrew tap:
> `brew install eyalev/tap/mobile-cc`.

---

## More tutorials

Planned walkthroughs (each will get its own short clip here):

- **Juggle multiple projects** — pinned tabs grouped by project, `+ New
  session`, and the status dots that tell you which session needs you.
- **Drive it from your phone keyboard** — the quick-keys row (`Esc`, `Tab`,
  `Ctrl-C`, arrows) and command chips.
- **Voice input** — dictate a message with Web Speech, or Groq Whisper for
  cleaned-up transcription.
- **Make desktop comfortable** — the centered column and the ⇕ width control.
- **Paste a screenshot into Claude Code** — attach an image from your phone.
- **Install it as an app (PWA)** — add mobile-cc to your home screen.

Want one of these next? Open an issue or ask.
