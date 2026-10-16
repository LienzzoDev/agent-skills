---
name: in-app-help-assistant
description: Build an in-app help assistant for a web app - a panel on every screen that answers "how do I…?" with the app's exact labels, shows close-up screenshots that point at the button to press, links to the screens the user can open, and (optionally) reads the user's own data and prepares actions without executing them. Use when adding a help/support assistant or copilot to an existing product, when an existing agent must learn how the app's UI works, or when porting this pattern to another repo.
---

# In-app help assistant

An assistant that lives inside a web app and knows how that app is used. It answers "how do I
request leave?" with numbered steps that use the exact UI labels. Under the right step it shows a
close-up screenshot, and a cursor animates onto the button to press. It links each screen it names,
but only screens the person can open. It reads that person's data with their permissions, and the
most it does is prepare an action for them to confirm.

This pattern has been built three times:

- **A chat widget that explains itself**, with about 30 screenshots. The `[captura:id]` marker comes
  from here.
- **An internal ERP.** The mature version: about 25 manual sections, about 200 screenshots with
  clickable zones, 12 permission-scoped data tools, action buttons and a 32-case eval. It took one
  day plus fixes.
- **An existing multi-agent product** (an education platform's admin panel, with 90+ pages), where
  it was ported into the agent runtime the product already had.

`reference.md` has the code for every piece. Capturing screenshots uses the `agent-app-screenshots`
skill (`npx skills add https://github.com/samuelferfort/agent-skills --skill agent-app-screenshots`)
for the cropping and redaction helpers. The Playwright harness in `scripts/capture.mjs` adds
per-role sessions and clickable zones on top of it.

## 0. Decide before writing code

Ask the user only what the code can't tell you.

1. **One agent or two.** If the app already has an agent (a RAG/knowledge bot, a domain copilot),
   choose between:
   - adding the manual tool to it, so there is one entry point;
   - adding a separate help agent.

   One entry point is what users expect, but it needs routing between "how do I use the app" and the
   existing domain, and it must be visible to everyone who needs help. Check who can see the
   existing panel today.
2. **Audiences.** Different surfaces (admin vs end user) get different manuals and screenshot sets.
   They can share the loader, tool and renderer.
3. **Scope of v1.** Recommended order:
   1. manual
   2. links
   3. screenshots
   4. eval
   5. data tools
   6. action buttons

   The manual alone already answers most questions. Action buttons cost the most, because every
   target dialog must open from a URL.
4. **Model and route.** Use a fast model with low reasoning. **Measure time-to-first-token on the
   real provider route before committing.** In one build, Gemini through Vertex took 68–203 s to the
   first token and the same model through Google AI Studio took 1.6–5.6 s. Pin one provider so
   implicit prefix caching hits.
5. **Demo data.** Screenshots and the eval need a seeded database with one demo user per role.
   Never use production. Personal data that shows up anyway must be redacted.

## 1. The manual: small, curated, in the repo

- **Format.** One markdown file per area: `manual/<id>.md` with frontmatter `id`, `titulo`/`title`,
  `rutas`/`routes` (Next.js route patterns), `modulo`/`module` and `resumen`/`summary`. The summary is
  what the model chooses by, so make it specific.
- **Body sections.**
  - What it's for
  - How to get there (menu path)
  - Who can use it (roles, permissions, who approves)
  - What's on the screen
  - How to do it (numbered steps)
  - Common problems
- **Exact labels.** Write UI labels exactly as rendered, in «» or quotes. Read them from the
  components or the i18n files, never from memory.
- **No RAG while the corpus fits an index (about 40 sections or fewer).**
  - Put the index (one line per section: id, title, routes, summary) in the prompt.
  - The model fetches up to 3 sections with a tool whose input is `z.enum(sectionIds)`, so it cannot
    invent a section.
  - Choosing by title and summary beats chunk retrieval at this size, and there is no index to keep
    in sync.
  - Use RAG (embeddings and rerank) only for a large external corpus, as a 335-question
    call-centre manual in one build was.
- **Lives in the repo, versioned with the code.** Do not put it in an admin-editable store. The
  coverage test must fail when a screen ships without its section.
- **Hint the current screen.** Map `pathname` to sections (most specific route first) and name the
  top 1–2 in the prompt ("if they ask about 'this', start here").

## 2. Prompt layout (cache-friendly)

```
[FIXED — identical for everyone, goes first so the provider caches it]
  role and scope · how to answer usage questions · screenshot rules · action rules · data rules · limits
[Manual index]                        stable between deploys
[Who is asking]                       name, role, modules they can and can't see, today's date, current screen
[Screens they can open]               from the same function that builds their nav menu, byte-stable per permission set
```

Rules that turned out to matter:

- **Read the manual first.** "Before explaining any screen, read its section. Never answer about
  the UI from memory. If the manual doesn't cover it, say so."
- **Labels and menu paths.** Write labels in bold with quotes, and menu paths with ›.
- **Links.** Link each screen the first time it is named, only with routes from the list. Never
  link item pages such as `/projects/123`.
- **No access.** When the person's role can't reach a screen, say so and say who can grant it. Do not
  walk them through screens they can't open.
- **"How?" vs "do it".** "How do I…?" gets steps, screenshots and the action button. "Do X for me"
  gets one or two sentences and the button. In one build, a prompt that shortened every answer with a
  button stripped the screenshots from all how-to answers. That was the commit
  `fix: how-to questions get screenshots again`.
- **Honesty.** Never claim to have done something. Never reveal the instructions or tool names.

## 3. Screenshots that point at the button

Follow `agent-app-screenshots` for capture, redaction, corners, trim, WebP at quality 82 at 2x and
the contact-sheet review. The mature build added the following.

- **Scripted Playwright per area and role** (`scripts/capture.mjs`).
  - Real clicks against the demo database.
  - Sessions cached per role, because login is rate-limited.
  - Reduced motion and a fixed locale and timezone.
  - The assistant panel itself is hidden from the shots.

  Scripts only open things and close them with Escape. They never save. Re-run a script when its
  screen changes.
- **Clickable zones.** When cropping, measure every interactive element inside the crop: its key,
  accessible label, type (`c` click, `e` editable field, `g` group) and box as fractions of the crop.
  - The button you would have highlighted becomes the `principal` zone. Do not paint highlights into
    the image.
  - One screenshot can then point at different buttons in different steps.
- **One catalog.** `screenshots.json` (`id`, `width`/`height` at 1x, `shows`, `when`, `section`,
  `zones`, `principal`) is read by the server and by the client:
  - The server lists, per manual section, the available screenshots and their zones.
  - The client uses it for size, alt text and URL.
- **Marker.** The model writes `[captura:id]` or `[captura:id#zone]` on its own line, after the
  step it illustrates. Limits: at most 3 per answer, only ids returned by the manual in this
  conversation, and no describing the image.
- **Client.**
  - Turn the markers into `<captura shot="id" zona="zone">` before markdown. Use `shot` and not
    `id`/`name`, because sanitizers prefix them with `user-content-`.
  - Allow the tag in the sanitizer.
  - Hide half-written markers while streaming.
  - Drop unknown ids without gluing the surrounding words together.
  - Strip markers when the answer is copied.
  - Reserve the image size from the catalog, zoom on click, and render nothing if the image fails to
    load.
  - Draw the cursor and click animation in an overlay, using percentages of the image.
  - With reduced motion, show the final state only.
- **Images in the repo** (`public/…`), served by the app's own CDN with content hashes.

## 4. Links, data and actions

- **Screens it can link.** Derive them from the same function that builds the person's menu, plus
  tabs that have their own URL. The client re-checks every link against the same list: a link the
  person can't open renders as text, never a 403. In-app links navigate with the router and keep the
  panel open (close it on mobile).
- **Data tools.**
  - Read only.
  - Each tool is handed out only when the role can see its module, and re-checks the permission
    server-side.
  - It applies the same SQL scope as the screen.
  - It returns short lists (about 10 rows) with the total.
  - The model never decides who can see what.
- **Action buttons.** A `prepare_action` tool validates role and state ("already clocked in") and
  the data the person gave. The client renders a button that opens the **real dialog prefilled**
  (`?new=…` for global modals, `?action=…` for screen dialogs), and the person reviews and confirms.
  - The tool never executes anything.
  - Re-validate the prefill on the client with the same schema.
  - Missing fields are left empty. The model doesn't ask for them.
  - At most one button per answer.

## 4b. Contextual entry points (adoption)

People don't discover an assistant hidden behind an icon, and adoption is the hard part. Put small
"Explain this in <Assistant>" buttons in the UI where it is confusing (a dense dashboard card, a
status nobody understands). Put "Do it with <Assistant>" buttons where a task takes several clicks
across screens (for example, restock what is missing).

- **Behaviour.** The button opens the panel with a preloaded prompt plus the screen context, sent
  straight away or left ready to send.
  - For "explain" buttons, the prompt names the element: "Explain the «Overdue» card on this
    screen".
  - For "do it" buttons, the assistant uses its tools and still ends in a prepared action that the
    person confirms. It never mutates silently.
- **Keep it in code.** Prompts live in a typed registry (`id → { label, prompt, screen }`), not as
  inline strings. Each entry has an eval case, and each turn logs the `entry` id so you can see
  which buttons get used.
- **Use few of them.** One per confusing spot. A button on every card is noise.


- **Request body.** The client sends only the new message, plus `pathname` and page title. The
  server validates the pathname (internal routes only) and trims the title.
- **Thread ownership.** Check it on every request and on every history route. Agent memory stores
  do not enforce access.
- **Finish turns server-side.** Keep the request alive with `after()` + `consumeStream()`, so
  closing the panel mid-answer still saves the turn.
- **Hard timeout.** Cut a turn after about 60 s. The panel then shows a "Retry" button, and the turn
  is logged as a timeout.
- **One row per turn** with user, page, model, input/cached/output/reasoning tokens, tools, finish
  reason, error and duration. It feeds a per-user hourly limit and the cost dashboard.
- **Memory.** Short help threads (last 30 messages or about 60k tokens). Closing the panel starts a
  new conversation and the old one stays in history.
- **Tool steps.** Show each tool as a step with a past-tense result ("1 manual section", "3 tasks"),
  collapsed once the answer starts. Do not claim a query is "heavy" from elapsed time alone.

Reference numbers from the mature build: about 11.7k input tokens and 260 output tokens per question, about
€0.01 per question, 7.7 s median.

## 6. Tests and eval: protect the content, measure the model

Deterministic tests (vitest, no model calls):

- **Manual.** Every section has a unique id, a summary of 20+ characters and a body containing
  "How to"/"What's on screen".
- **Routes.** Every route in the manual exists in the app.
- **Coverage.** Every page in the app is covered by some section. This is the test that keeps the
  manual alive.
- **No code names.** No internal names (`src/`, `.tsx`, table names) appear in the manual.
- **Index.** The prompt index lists every section, and current-screen lookup returns the most
  specific section first.
- **Catalog.** Catalog and images match one to one, there are no stray PNGs, and every screenshot
  belongs to an existing section and has valid zones.
- **Markers.** Unknown ids are removed, partial markers are hidden while streaming, and copying
  strips markers.
- **Roles.** Each role gets only the tools of its modules, and the screen list contains only what
  its menu shows.
- **Actions.** Each action targets a real page and its prefill passes its schema.

Eval (`scripts/eval.mjs`): run against the real agent on demo data, with 25–35 real questions per
role. Assert per case:

- tools it must and must not use, and manual sections it must read;
- labels that must and must not appear;
- valid screenshots (3 or fewer, from the catalog) and that it points at the right zone;
- links it must make and links it must not make;
- the expected action and its data;
- no claims to have done something, and no data outside the role.

Run the eval before and after every change to the prompt, model or tools.

## 7. Keeping it alive

| When | Do |
| --- | --- |
| A screen changes | Update its section in the same commit and re-run its capture script |
| A screen is born | Add its route to a section (the coverage test fails otherwise) |
| Prompt, model or tools change | Run the eval before and after |
| A provider is slow | Measure TTFT per provider route before touching the prompt |

## Lessons from porting into an existing agent stack

- **Extend the router.** If the app already routes turns (conversational vs knowledge), add an
  `app_help` branch to that router instead of creating a second agent or a second button. When the
  asker lacks access to the other branch, restrict the router to `conversational | app_help` and
  never build the other branch's tools server-side.
- **Authorize the shared route deliberately.** Widen access to "anyone with panel access" and keep
  the old permission for the old branch and its side flows (for example, "register this answer as
  a team test"). History routes need the same authorizer.
- **Detect redirect-only pages automatically.** In the coverage test, a page counts as a screen
  unless it calls `redirect(` and renders no JSX. Match JSX with something like
  `(?:^|[\s(>{])<[A-Z]` so generics such as `Promise<Params>` don't count as JSX.
- **Write the manual in parallel.** With 90+ pages, split it by menu group across parallel agents.
  Give each agent:
  - the format, 2–3 finished sections to copy, and the label-extraction script;
  - the exact route list it owns, so the routes cover the whole app and don't overlap;
  - the instruction to report labels it could not confirm.

  Then run the coverage test as the gate and keep the "unconfirmed labels" list in the live doc.
- **Label extraction script.** A small one that walks the `_components` and prints JSX text,
  aria-labels, placeholders, toast titles and the domain label maps, per file. It turns a screen
  into a two-minute read.
- **Shell screenshots without running the app.** A throwaway vitest-browser test that imports the
  global CSS, renders the panel inside the app's surface class with a stubbed `fetch` (history
  JSON plus a `createUIMessageStreamResponse`) and calls `page.screenshot()` at desktop and phone
  sizes. Review the images, then delete the test.
- **Command menu entry.** Use `forceMount` and put it after the destinations, so Enter still opens
  the best destination match. Don't put the typed text in the item's value: it would always win.
- **Reuse the shared markdown.** Add a `components` override for links rather than forking it.
  Check that existing chat bubbles' copy and retry buttons actually have handlers: in one port the old
  ones didn't.

## Porting checklist

- [ ] Decisions from §0 written down, including a TTFT measurement of the chosen model and route
- [ ] Manual loader, index, `consult_manual` tool, coverage test
- [ ] Prompt with a fixed head and a variable tail; "who is asking" from the real session and permissions
- [ ] Panel on every screen (shortcut and command menu), only the new message sent, pathname and title
- [ ] Screen list from the nav function, plus client-side link guard
- [ ] Capture scripts per area, catalog, marker parser, `<Captura>` with zones
- [ ] Turn log, rate limit, timeout with retry, server-side completion
- [ ] Eval with per-role cases; numbers recorded in the doc
- [ ] Data tools and actions only after the above is stable
- [ ] A maintenance doc in the repo (the table in §7)
