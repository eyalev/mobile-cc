# mobile-cc tutorials

Short, focused walkthroughs of mobile-cc. Start with installation, then dip
into individual features as you need them.

---

## 1. Installing mobile-cc

Run one command on the machine where Claude Code lives — it downloads and
**verifies** the binary, installs a systemd user service that keeps it
running, and prints the URL to open.

<p align="center">
  <img src="../media/install.gif" alt="Installing mobile-cc with one command" width="640">
</p>

```bash
curl -fsSL https://mobile-cc.dev/install.sh | bash
```

That's the install itself. To actually drive Claude Code from your phone you
then expose it over Tailscale and open the URL — the full four-step flow
(including the tunnel) is in the main
[**Quickstart**](../../README.md#quickstart). Prefer a package manager or to
read the script before running it? See
[Install options](../../README.md#install-options).

> **Heads-up:** the install experience is being upgraded (binaries served
> straight from GitHub Releases, signature + build-provenance verification, a
> Homebrew tap). This clip will be re-recorded when that ships.

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
