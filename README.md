# Pendant — Fanuc G-Code Generator & Interactive Control Simulator

**[▶ Try the live app](https://perfecthost-ship-it.github.io/pendant/standalone/pendant-standalone.html)**, or see
[Quick preview](#quick-preview-no-setup-no-build) below.

A desktop app that generates Fanuc-dialect G-code from machining parameters (pocket,
drilling, bolt-hole circle, facing, circular pocket, profile milling), paired with a
working replica of a Fanuc control panel — power/E-stop interlocks, jog, MPG, MDI
program entry, and a Cycle Start that actually runs the generated program — for
practicing controller operation without a machine in front of you.

I built this to demonstrate CNC programming knowledge concretely rather than just
claim it on a CV: every G-code decision below reflects how a real Fanuc control
actually behaves, not just what produces a plausible-looking program.

## What this demonstrates

- **Correct program structure** — `G54`-`G59` work offsets, `G43` tool length comp,
  forced retract-to-home (`G91 G28 Z0`) before every tool change, coolant/spindle
  sequencing in the right order
- **Ramped and helical entry, not straight plunges** — every roughing pass ramps or
  helixes into material rather than plunging straight down, which is what a
  non-center-cutting tool actually requires
- **A true spiral toolpath for circular pockets** — not a ring-by-ring approximation;
  the tool traces a continuous Archimedean spiral, matching how this is actually
  machined
- **Canned cycles used correctly** — `G83` peck drilling with proper chaining across a
  bolt-hole pattern (only the first hole repeats the full cycle block; the rest just
  update position, exactly like a real post-processor)
- **Realistic alarm conditions** — overtravel limits, a tool called that isn't in the
  magazine, a `G43 H_` that doesn't match the tool actually loaded, a cutting move
  commanded with the spindle stopped, a required zero-return after E-stop or power-up.
  These are the mistakes an operator actually has to catch, not decorative UI states
- **Input validation that matches what can go physically wrong** — a zero tool
  diameter or zero depth-per-pass isn't just rejected by a form field; the app also
  won't let the underlying G-code generator produce a physically nonsensical or
  unbounded program in the first place

## Quick preview (no setup, no build)

**[▶ Try the live app](https://perfecthost-ship-it.github.io/pendant/standalone/pendant-standalone.html)**, or see
[Quick preview](#quick-preview-no-setup-no-build directly in any browser — double-click it.
Everything (including the G-code engine) is inlined into that one file, so there's
nothing else it depends on.

*(If you're viewing this on GitHub Pages, link directly to a hosted copy of that
same file — see [Hosting a live demo](#hosting-a-live-demo) below.)*

## What's implemented

- Six operations: rectangular pocket, peck drilling (G83), bolt hole circle, facing,
  circular pocket, and profile/contour milling
- Fanuc 0i-MF dialect, inch/metric toggle (G20/G21) with correct decimal precision
  per system
- Linear ramp entry (rectangular pocket) and true helical interpolation entry
  (circular pocket) every depth pass
- Inline toolpath viewer — parses the generated program itself and color-codes
  rapid/cut/ramp/drill moves, so you can see what the code actually does before
  running it anywhere
- A functional control panel simulator: power/E-stop/servo-ready/zero-return
  interlocks, jog, MPG (drag the dial or use the buttons), MDI program entry via an
  on-screen (and real-keyboard-typeable) QWERTY layout, Cycle Start/Feed Hold/Single
  Block actually running a loaded program with override-scaled timing, a live part
  preview showing the tool position against the toolpath
- Native "Save As" dialog on export when running as a real desktop app via Tauri
  (falls back to a browser download when opened as a plain web page)

## Project layout

```
standalone/pendant-standalone.html  → single-file build, engine.js inlined - just open it
src/                   → the app itself (plain HTML/CSS/JS, no bundler)
  index.html           → UI shell (Generator + Simulator, split-screen)
  engine.js            → G-code generation logic (all six operations)
src-tauri/             → the native desktop shell (Tauri + Rust)
  src/main.rs          → Rust entry point, registers dialog + fs plugins
  tauri.conf.json       → window size, bundle identity, permissions
  capabilities/default.json → what the frontend is allowed to do natively
```

Because there's no frontend build step, editing `src/engine.js` or `src/index.html`
is a save-and-reload — no compile step on the JS side. Only Rust changes need a
rebuild. `standalone/pendant-standalone.html` is a generated copy with `engine.js`
inlined for zero-setup viewing; regenerate it after editing `src/engine.js` (see
below) rather than editing the standalone file directly.

## Running it as a real desktop app (Tauri)

1. Install the Rust toolchain: https://www.rust-lang.org/tools/install
2. Install Tauri's platform prerequisites: https://v2.tauri.app/start/prerequisites/
3. `npm install`
4. `npm run dev` — opens in a real native window, hot-reloads on save
5. `npm run build` — produces a real installer in
   `src-tauri/target/release/bundle/` for whichever OS you build on

## Regenerating the standalone build after an engine.js change

```
python3 -c "
with open('src/engine.js') as f: engine_js = f.read()
with open('src/index.html') as f: html = f.read()
html = html.replace('<script src=\"engine.js\"></script>', '<script>\n' + engine_js + '\n</script>')
with open('standalone/pendant-standalone.html', 'w') as f: f.write(html)
"
```

## Hosting a live demo

GitHub Pages will serve `standalone/pendant-standalone.html` directly since it's a
complete, dependency-free page. In the repo's Settings → Pages, set the source to
the `main` branch, then link directly to:

```
https://<username>.github.io/<repo-name>/standalone/pendant-standalone.html
```

That's the single most useful link to put in a CV or cover letter — it lets someone
try the actual app in a browser tab with no install.

## Known gaps / next steps

- Only one Fanuc dialect (0i-MF) — 31i and others have minor syntax differences
  worth branching
- No tool/material feed-speed presets yet
- Profile/contour milling is centerline-only — no cutter compensation
- Simulator: E-stop release is a click-toggle rather than the physical
  twist-release; G91 incremental mode isn't simulated
