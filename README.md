# agent-skills

Skills for coding agents (Claude Code, Codex and other tools that read `SKILL.md`).

| Skill | What it does |
| --- | --- |
| [`in-app-help-assistant`](skills/in-app-help-assistant/SKILL.md) | Builds an in-app help assistant for a web app: a panel on every screen that answers "how do I…?" with the app's exact labels, close-up screenshots that point at the button, links to the screens the user can open and, optionally, permission-scoped data and prepared actions. |

## Install

```bash
npx skills add https://github.com/LienzzoDev/agent-skills --skill in-app-help-assistant
```

It works well together with
[`agent-app-screenshots`](https://github.com/samuelferfort/agent-skills), which covers capturing
and redacting the screenshots.

## License

[MIT](LICENSE).
