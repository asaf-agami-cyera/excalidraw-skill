# Excalidraw skill

An agent skill for [OpenCode](https://opencode.ai) (and other tools that read `SKILL.md` skills,
such as Claude Code) that lets the agent draw Excalidraw diagrams.

The agent writes a JSON skeleton of the diagram, and `scripts/excalidraw` turns it into a real
Excalidraw scene using Excalidraw's own library in headless Chrome. It renders a PNG so the agent
can check its work before showing it to you, and serves a local editor at
`http://127.0.0.1:4517` where you can edit the diagram. Your edits are saved automatically, and the
agent can read them back. Nothing is uploaded.

## Requirements

- Node.js 22.18 or newer, with `npm`
- `rsync`
- Google Chrome, or Playwright's Chromium: `npx playwright install chromium --only-shell`

The first run installs about 300 MB of npm dependencies into `~/.cache/excalidraw-skill/app` and
takes about a minute. The skill folder itself only holds sources.

## Install in OpenCode

OpenCode finds skills by their folder, and the folder name must match the skill's name,
`excalidraw`. Clone the repo into one of OpenCode's skill folders.

For all your projects:

```sh
git clone https://github.com/asaf-agami-cyera/excalidraw-skill.git ~/.config/opencode/skills/excalidraw
```

For a single project, run this from the project's root:

```sh
git clone https://github.com/asaf-agami-cyera/excalidraw-skill.git .opencode/skills/excalidraw
```

OpenCode also reads `~/.claude/skills/` and `~/.agents/skills/` (and their project-level
`.claude/skills/` and `.agents/skills/` equivalents), so either works if you share skills with
other tools.

Restart OpenCode so it picks up the new skill, then check the setup:

```sh
~/.config/opencode/skills/excalidraw/scripts/excalidraw selftest
```

To update, `git pull` in the skill folder. The next run syncs the new sources and rebuilds.

## Use

Ask the agent for a diagram, for example "draw an Excalidraw diagram of how a request flows
through this service". The agent loads the skill, renders and checks the diagram, and opens it in
your browser when you ask to see it. Run `scripts/excalidraw open` to browse all saved diagrams.

Diagrams are stored in `~/.local/share/excalidraw-skill/scenes/`.

## Configuration

| Variable | Default |
| --- | --- |
| `EXCALIDRAW_SKILL_PORT` | `4517` |
| `EXCALIDRAW_SKILL_DATA_DIR` | `$XDG_DATA_HOME/excalidraw-skill`, else `~/.local/share/excalidraw-skill` |
| `EXCALIDRAW_SKILL_APP_DIR` | `$XDG_CACHE_HOME/excalidraw-skill/app`, else `~/.cache/excalidraw-skill/app` |
