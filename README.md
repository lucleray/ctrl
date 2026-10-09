<p align="center">
  <img src="build/icon.png" width="128" alt="ctrl icon" />
</p>

<h1 align="center">ctrl</h1>

<p align="center">
  A cozy desktop home for your <a href="https://opencode.ai">opencode</a> and <a href="https://fx.sh">fx</a> sessions 🌊
</p>

<table>
  <tr><th>fx</th><th>opencode</th></tr>
  <tr>
    <td><img src="docs/media/hero-fx.png" alt="ctrl: the same spaces with fx sessions, an fx session on the right, and the links it shared in the resources panel" /></td>
    <td><img src="docs/media/hero.png" alt="ctrl: spaces and sessions in the sidebar, an opencode session on the right, and the links it shared in the resources panel" /></td>
  </tr>
</table>

ctrl puts a sidebar around the real opencode and fx terminals. Group sessions into spaces (both kinds can
share one), see which ones need you, and switch between them instantly.

## ✨ Highlights

### 🗂️ Spaces, and what needs you

Group sessions by project. A space can start new sessions in its own folder, with its own model and
instructions. Dots show what needs you: blue when a run finished, red when it failed, amber when the agent is
waiting for your answer.

### 🧠 Reference one session from another

Drag a session onto the terminal. ctrl pastes a mention, and the agent reads that session before it answers.

<table>
  <tr><th>fx</th><th>opencode</th></tr>
  <tr>
    <td><img src="docs/media/reference-fx.gif" alt="Dragging a session from the sidebar onto the fx terminal pastes a session mention into the prompt" /></td>
    <td><img src="docs/media/reference.gif" alt="Dragging a session from the sidebar onto the opencode terminal pastes an @session mention into the prompt" /></td>
  </tr>
</table>

### 🔗 Every link in one place

PRs, issues, deploys, Linear tickets and Slack threads shared in a session, or in its whole space. GitHub links
show live status: draft, CI, merged.

<table>
  <tr><th>fx</th><th>opencode</th></tr>
  <tr>
    <td><img src="docs/media/resources-fx.png" width="390" alt="The resources panel next to an fx session, listing the same kinds of links" /></td>
    <td><img src="docs/media/resources.png" width="390" alt="The resources panel next to an opencode session, listing pull requests, issues, a Linear ticket, a Slack thread and a Vercel deployment" /></td>
  </tr>
</table>

### 🔍 Search everything

⌘P searches session titles and the text of every message.

<table>
  <tr><th>fx</th><th>opencode</th></tr>
  <tr>
    <td><img src="docs/media/search-fx.png" alt="The search palette over fx sessions, showing chats and messages matching 'test'" /></td>
    <td><img src="docs/media/search.png" alt="The search palette over opencode sessions, showing chats and messages matching 'test'" /></td>
  </tr>
</table>

### ⚡ Jump with ⌘1–9

Hold ⌘ to see a number next to each session, then press it.

<table>
  <tr><th>fx</th><th>opencode</th></tr>
  <tr>
    <td><img src="docs/media/jump-fx.png" width="250" alt="Sidebar of fx sessions with ⌘1 to ⌘9 badges" /></td>
    <td><img src="docs/media/jump.png" width="250" alt="Sidebar of opencode sessions with ⌘1 to ⌘9 badges" /></td>
  </tr>
</table>

## 📦 Install

You need a Mac and [opencode V2](https://opencode.ai/v2/docs/) (2.0.25 or newer), [fx](https://fx.sh), or both:

```bash
curl -fsSL https://opencode.ai/v2/install | bash   # opencode
curl -fsSL https://fx.sh/setup.sh | bash           # fx
```

Then install ctrl:

```bash
curl -fsSL https://raw.githubusercontent.com/lucleray/ctrl/main/install.sh | sh
```

ctrl updates itself. [docs/USAGE.md](docs/USAGE.md) covers updates, uninstalling and everyday use.

## 📚 Docs

- [Usage](docs/USAGE.md): install details, spaces, shortcuts, settings
- [Features](docs/FEATURES.md): everything ctrl does
- [Harnesses](docs/HARNESSES.md): opencode and fx, and what ctrl supports for each
- [Architecture](docs/ARCHITECTURE.md): how it works inside
- [Development](docs/DEVELOPMENT.md): run, release, debug hooks, screenshots
