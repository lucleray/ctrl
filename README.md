<p align="center">
  <img src="build/icon.png" width="128" alt="ctrl icon" />
</p>

<h1 align="center">ctrl</h1>

<p align="center">
  A cozy desktop home for your <a href="https://opencode.ai">opencode</a> sessions 🌊
</p>

<p align="center">
  <img src="docs/media/hero.png" alt="ctrl: spaces and sessions in the sidebar, an opencode session on the right, and the links it shared in the resources panel" />
</p>

ctrl puts a sidebar around the real opencode TUI. Group sessions into spaces, see which ones need you, and
switch between them instantly.

## ✨ Highlights

### 🗂️ Spaces, and what needs you

Group sessions by project. A space can start new sessions in its own folder, with its own model and
instructions. Dots show what needs you: blue when a run finished, red when it failed, amber when the agent is
waiting for your answer.

### 🧠 Reference one session from another

Drag a session onto the terminal. ctrl pastes a mention, and the agent reads that session before it answers.

<img src="docs/media/reference.gif" alt="Dragging a session from the sidebar onto the terminal pastes an @session mention into the prompt" />

### 🔗 Every link in one place

PRs, issues, deploys, Linear tickets and Slack threads shared in a session, or in its whole space. GitHub links
show live status: draft, CI, merged.

<img src="docs/media/resources.png" width="390" alt="The resources panel listing pull requests, issues, a Linear ticket, a Slack thread and a Vercel deployment" />

### 🔍 Search everything

⌘P searches session titles and the text of every message.

<img src="docs/media/search.png" width="550" alt="The search palette showing chats and messages matching 'test'" />

### ⚡ Jump with ⌘1–9

Hold ⌘ to see a number next to each session, then press it.

<img src="docs/media/jump.png" width="250" alt="Sidebar with ⌘1 to ⌘9 badges next to sessions" />

## 📦 Install

You need a Mac and [opencode V2](https://opencode.ai/v2/docs/):

```bash
curl -fsSL https://opencode.ai/v2/install | bash
```

Then install ctrl:

```bash
curl -fsSL https://raw.githubusercontent.com/lucleray/ctrl/main/install.sh | sh
```

ctrl updates itself. [docs/USAGE.md](docs/USAGE.md) covers updates, uninstalling and everyday use.

## 📚 Docs

- [Usage](docs/USAGE.md): install details, spaces, shortcuts, settings
- [Features](docs/FEATURES.md): everything ctrl does
- [Architecture](docs/ARCHITECTURE.md): how it works inside
- [Development](docs/DEVELOPMENT.md): run, release, debug hooks, screenshots
