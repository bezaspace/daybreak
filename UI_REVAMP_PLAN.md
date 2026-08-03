# Daybreak UI Revamp Plan

**Status:** Superseded by [`CHAT_FIRST_UI_PLAN.md`](./CHAT_FIRST_UI_PLAN.md). The foundation work in this document (design tokens, Base UI wrappers, dark theme, sidebar shell) has already been implemented in Milestone 0. The product direction has since shifted to a chat-first, three-pane agent experience; see the new plan for the updated scope.  
**Scope (historical):** `packages/ui` plus the minimal control-plane endpoints required to support new UI interactions.  
**Component library:** [`@base-ui/react`](https://base-ui.com/react/overview/quick-start) (unstyled, accessible primitives) + **Tailwind CSS** for styling.  
**Theme:** Dark-only, jet-black heavy (`#050505` / `#0a0a0a` / `#111111`) with subtle gray (`#171717`, `#262626`) surfaces, electric-indigo (`#6366f1`) as the primary accent, and green/red/yellow semantic accents.

## Current state (why this revamp is needed)

I verified the repo locally before writing this plan:

- `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm --filter ui build` all pass.
- `pnpm test` has **one failure** in `packages/control-plane/src/server.test.ts` (`skips a third heal attempt` expects `"max heal attempts"` but receives `"heal already in flight"`).
- The control plane starts on `localhost:8787` and the Vite UI starts on `localhost:5173`.
- The UI works end-to-end, but several functional bugs and missing interactions make it feel like a prototype:
  - **Status out of sync:** a completed task opened via `?taskId=...` still shows `Status: running` because the local status state is only updated by SSE events, not from the persisted task object.
  - **No event replay for completed tasks:** the terminal is empty for old tasks because the app only subscribes to the live SSE stream and never fetches `/api/tasks/:id/events` on mount.
  - **Task list is inert:** the "Recent tasks" list has no click handler; the only way to open a task is to edit the URL.
  - **Missing approval UI:** `REQUIRE_APPROVAL_FOR_DESTRUCTIVE=true` exists in the config, but there is no UI surface to approve/reject destructive actions (`git push`, `rm -rf`, PR open, etc.).
  - **Fragile SSE connection:** `EventSource.onerror` is empty, so a control-plane restart leaves the terminal hanging with no reconnect or error state.
  - **Missing interactions:** no active-task cancel button, no provider/model picker, no event filters, no search, no responsive layout, no design system, and no dark-theme polish.
  - **Time Travel empty for traced tasks:** the Trace view rendered for an old task, but the Time Travel view showed `No checkpoints for this task yet.`, suggesting checkpoints are either not persisted for every run or the UI is asking the wrong endpoint.

---

## 1. Goals

1. Make the dashboard feel like a professional developer tool rather than a prototype.
2. Fix the functional UI bugs listed in the current-state section above.
3. Implement all UI/UX improvements identified during local verification:
   - Live/historical terminal with filters, pause/resume, copy, search.
   - Sidebar layout with persistent navigation.
   - Provider/model selector, presets, and per-task overrides.
   - Rich trace and time-travel trees.
   - Cost burn charts and global settings.
   - Responsive, accessible, keyboard-friendly UI.

---

## 2. Non-goals

- No change to the agent execution model or E2B sandbox behavior.
- No rewrite of the control plane to Cloudflare Workers (Phase 7 stays deferred).
- No new LLM providers or eval fixtures.
- No billing, multi-tenant SaaS, or public sign-up flow.

---

## 3. Design system

### 3.1 Color palette (dark-only)

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-page` | `#050505` | Root page background |
| `bg-surface` | `#0a0a0a` | Cards, panels, modals |
| `bg-elevated` | `#111111` | Input, selects, hover surfaces |
| `bg-subtle` | `#171717` | Secondary panels, active item |
| `border` | `#262626` | Dividers, card borders |
| `border-strong` | `#404040` | Focus rings, selected borders |
| `text-primary` | `#f5f5f5` | Headings, primary text |
| `text-secondary` | `#a3a3a3` | Labels, timestamps, muted text |
| `text-tertiary` | `#737373` | Disabled, placeholders |
| `accent` | `#6366f1` | Primary buttons, links, active state |
| `accent-hover` | `#818cf8` | Hover state |
| `success` | `#22c55e` | Complete, healthy checks |
| `warning` | `#eab308` | Cost alert, in-flight |
| `danger` | `#ef4444` | Failed, destructive, blocked |
| `info` | `#38bdf8` | Info, trace spans |

### 3.2 Typography and spacing

- Font: `Inter` (system fallback `ui-sans-serif, system-ui, sans-serif`).
- Monospace: `JetBrains Mono` for terminal, trace, code blocks.
- Base font size: `14px`, line height `1.5`.
- Spacing scale: Tailwind defaults (4px grid). Primary gaps: `gap-4` panels, `p-4`/`p-6` card padding.

### 3.3 Layout

- **App shell:** fixed left sidebar (64px collapsed, 240px expanded) + main content area.
- **Main areas:**
  - `Run` (trigger + live terminal + task details).
  - `Tasks` (searchable/filterable task list + detail).
  - `Trace` (per-task reasoning tree).
  - `Time Travel` (checkpoint tree + diff).
  - `Costs` (spend dashboard).
  - `CI Heal` / `Dead Letter` / `Cleanup` (admin tools).
- Mobile: sidebar collapses to a bottom/tab bar or hamburger drawer.

---

## 4. Component library

We will install:

```bash
pnpm --filter @daybreak/ui add @base-ui/react lucide-react recharts
```

- **`@base-ui/react`** for unstyled, accessible primitives: `Accordion`, `AlertDialog`, `Button`, `Checkbox`, `Collapsible`, `Dialog`, `Drawer`, `Field`, `Form`, `Input`, `Menu`, `Popover`, `Progress`, `ScrollArea`, `Select`, `Separator`, `Slider`, `Switch`, `Tabs`, `Toast`, `Tooltip`, etc.
- **Tailwind CSS** for styling these primitives via `className`.
- **`lucide-react`** for consistent iconography.
- **`recharts`** for cost / usage charts.

Styling approach: each Base UI part gets a thin wrapper component in `packages/ui/src/components/base/` (e.g., `Button.tsx`, `Dialog.tsx`) that applies the dark-theme Tailwind classes. Higher-level screens import these wrappers, not Base UI directly.

---

## 5. Milestones

### Milestone 0 — Foundation & design tokens

**Goal:** Set up the styling system, Base UI integration, and global app shell.

**Files:**
- `packages/ui/package.json` — add dependencies.
- `packages/ui/tailwind.config.js` (or inline in CSS) — add dark color tokens.
- `packages/ui/src/index.css` — CSS variables, font imports, base body styles.
- `packages/ui/src/components/base/*` — initial wrapper components: `Button`, `IconButton`, `Input`, `Select`, `Dialog`, `AlertDialog`, `Popover`, `Tooltip`, `Badge`, `Card`.
- `packages/ui/src/App.tsx` — replace with a global `ThemeProvider`/shell and a `Router`.
- `packages/ui/src/main.tsx` — ensure CSS is imported.

**Acceptance criteria:**
- [ ] `pnpm --filter ui build` passes.
- [ ] UI renders with the jet-black theme and no inline styles remain on the new shell.
- [ ] Storybook-like smoke test: every base wrapper renders without errors (manual page check).

---

### Milestone 1 — Task list and task detail (fix core navigation)

**Goal:** Make tasks discoverable and openable; sync status from persisted state; load historical events.

**Files:**
- `packages/ui/src/App.tsx` — add client-side URL routes (e.g., `?view=tasks&taskId=...`) and a `TaskProvider`.
- `packages/ui/src/views/TasksView.tsx` (new) — sortable/filterable task list with Base UI `Table` or custom list.
- `packages/ui/src/components/TaskList.tsx` (new) — columns: status badge, repo/branch, trigger, provider, cost, started, actions (open, cancel when pending).
- `packages/ui/src/components/TaskStatus.tsx` (new) — derive status from `/api/tasks/:id` and color-code with `Badge`.
- `packages/ui/src/hooks/useTaskEvents.ts` (new) — on mount: `GET /api/tasks/:id/events` then fall back to `SSE /api/tasks/:id/stream` for live updates.
- `packages/control-plane/src/server.ts` — ensure `GET /api/tasks/:id/events` returns persisted events in chronological order (should already exist; verify). If missing, add it.

**Acceptance criteria:**
- [ ] Clicking a task opens the detail view and updates the URL.
- [ ] Completed tasks show `complete` status immediately, not `running`.
- [ ] Terminal is pre-populated with the full historical event log for old tasks.
- [ ] Pending tasks show a working cancel button.

---

### Milestone 2 — Terminal / stream revamp

**Goal:** Turn the raw `<pre>` into a usable developer console.

**Files:**
- `packages/ui/src/components/Terminal.tsx` (new) — virtualized or paginated log, auto-scroll toggle, pause/resume, copy-all, timestamp toggle, event-type filters.
- `packages/ui/src/components/EventRow.tsx` (new) — individual event renderer with syntax highlighting for tool calls, errors, and screenshots.
- `packages/ui/src/hooks/useEventStream.ts` (new) — robust `EventSource` with reconnect, error toasts, and optional backoff.
- `packages/ui/src/App.tsx` — integrate the new terminal in the `Run` view.

**Acceptance criteria:**
- [ ] Event stream reconnects automatically after a control-plane restart.
- [ ] User can pause auto-scroll and resume.
- [ ] Filter buttons for `tool_execution_*`, `message_update`, `compaction`, `browser_screenshot`, `cost_alert`, etc.
- [ ] Screenshot events show as thumbnails that expand in a Base UI `Dialog` lightbox.
- [ ] Terminal supports a search/filter text box.

---

### Milestone 3 — Run / trigger view

**Goal:** Improve the task trigger form and add presets/provider picker.

**Files:**
- `packages/ui/src/views/RunView.tsx` (new) — form with `Field`, `Input`, `Select`, `Slider` (max turns, max cost, max time), and model/provider selector.
- `packages/ui/src/components/ProviderPicker.tsx` (new) — primary and fallback provider cards, shows current active provider during a run.
- `packages/ui/src/components/PresetButtons.tsx` (new) — "Fix failing-sum test" and "Demo MAX_TURNS=3" styled as `Button` variants.
- `packages/ui/src/components/CircuitBreakerPanel.tsx` (new) — small readout of `MAX_TURNS` / `MAX_COST` / `MAX_WALL_CLOCK`.

**Acceptance criteria:**
- [ ] All fields are Base UI controlled inputs.
- [ ] Provider/model overrides are passed in `POST /api/tasks` body (confirm backend supports them; `server.ts` already reads them as `task.maxTurns`, etc.).
- [ ] Presets are visually distinct and disabled while a task is running.

---

### Milestone 4 — Approval gates and active-task controls

**Goal:** Surface destructive-action approvals in the UI.

**Backend changes:**
- Add `POST /api/tasks/:id/approve` and `POST /api/tasks/:id/reject` to `packages/control-plane/src/server.ts`.
- Expose an `approval_request` event type from the agent runner and persist it.

**UI files:**
- `packages/ui/src/components/ApprovalDialog.tsx` (new) — Base UI `AlertDialog` showing the requested action (`git push`, `rm -rf`, `pr_created`, etc.).
- `packages/ui/src/components/ActiveTaskToolbar.tsx` (new) — cancel, approve, pause/refresh controls.
- `packages/ui/src/views/RunView.tsx` — listen for `approval_request` events and open the dialog.

**Acceptance criteria:**
- [ ] When an `approval_request` event arrives, the UI opens a blocking dialog.
- [ ] Approve/reject posts to the new endpoints and the task continues or aborts.
- [ ] A running task can be cancelled from the toolbar.

---

### Milestone 5 — Trace view revamp

**Goal:** Make the reasoning tree explorable, searchable, and linked to the terminal.

**Files:**
- `packages/ui/src/views/TraceView.tsx` — rewrite with Base UI `Accordion`/`Collapsible` nodes.
- `packages/ui/src/components/TraceNode.tsx` (new) — color-coded by type (LLM, tool, turn, compaction), shows cost/latency/tokens, expandable metadata JSON.
- `packages/ui/src/components/TraceSearch.tsx` (new) — filter by tool name, model, or text in metadata.
- `packages/ui/src/hooks/useTrace.ts` — load `/api/tasks/:id/trace`.

**Acceptance criteria:**
- [ ] Collapse/expand all nodes.
- [ ] Search filters the visible tree.
- [ ] Clicking a `tool_execution_*` node scrolls the terminal to the matching event (if present).
- [ ] `llm` spans show non-zero latency (investigate `startTime`/`endTime` issue; fix in `packages/agent-runner/src/telemetry.ts` if needed).

---

### Milestone 6 — Time Travel view revamp

**Goal:** Turn the checkpoint tree into a usable branching/diff tool.

**Files:**
- `packages/ui/src/views/TimeTravelView.tsx` — rewrite with a tree layout.
- `packages/ui/src/components/CheckpointTree.tsx` (new) — recursive tree, status color coding, expand/collapse.
- `packages/ui/src/components/ForkDialog.tsx` (new) — Base UI `Dialog` with prompt input and strategy selector (`git-reinstall` / `snapshot` / `auto`).
- `packages/ui/src/components/RewindDialog.tsx` (new) — confirm rewind target.
- `packages/ui/src/components/CheckpointDiff.tsx` (new) — fetch and show file diff for a checkpoint (may require a new backend endpoint `GET /api/checkpoints/:id/diff` or reuse git commit).

**Backend changes (optional):**
- `packages/control-plane/src/server.ts` — `GET /api/checkpoints/:id/files` returning the file list and optionally diff against parent.

**Acceptance criteria:**
- [ ] Tree is interactive: expand/collapse, zoom/pan for large trees.
- [ ] Fork/rewind prompts are clear dialogs with validation.
- [ ] Promote/abandon buttons give immediate feedback.
- [ ] Empty checkpoint state explains why and links to run a task.

---

### Milestone 7 — Costs, CI Heal, Dead Letter, Cleanup

**Goal:** Polish the secondary dashboards.

**Files:**
- `packages/ui/src/views/CostsView.tsx` (new from `CostDashboard.tsx`) — `recharts` bar/line charts for provider and daily spend, total burn card, task list with cost.
- `packages/ui/src/views/CiHealView.tsx` — table with inline "trigger heal" / "view PR" / "view log" actions, filter by status.
- `packages/ui/src/views/DeadLetterView.tsx` — retry and inspect with Base UI `Dialog`.
- `packages/ui/src/views/CleanupView.tsx` — grouped action cards with `AlertDialog` confirmation before destructive cleanup.

**Acceptance criteria:**
- [ ] Cost dashboard has at least one chart.
- [ ] CI Heal table actions work.
- [ ] Cleanup destructive actions require confirmation.

---

### Milestone 8 — Responsive, accessibility, and final QA

**Goal:** Ship a polished, accessible, mobile-friendly UI.

**Files:**
- `packages/ui/src/components/Sidebar.tsx` — responsive drawer/collapsible rail.
- `packages/ui/src/components/MobileNav.tsx` — bottom/tab bar on narrow viewports.
- `packages/ui/src/components/ThemeToggle.tsx` — dark-only (toggle can be omitted or kept for future light mode), but add a contrast/zoom setting.
- `packages/ui/src/App.tsx` — final routing polish.
- `packages/ui/vite.config.ts` — verify proxy still works.
- `packages/ui/tsconfig.json` — if needed, update path aliases for clean imports.

**Acceptance criteria:**
- [ ] UI is usable at 375px width.
- [ ] All interactive elements are keyboard accessible and have visible focus states.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass after UI-only test updates.
- [ ] `pnpm --filter ui build` produces a clean dist.
- [ ] Manual end-to-end smoke test: trigger a task, view trace, open time travel, view costs.

---

## 6. API/backend surface we may need to add or verify

The UI revamp is frontend-first, but a few backend additions are required:

| Endpoint | Purpose | Priority |
|----------|---------|----------|
| `GET /api/tasks/:id/events` | Replay persisted event stream. | Required (verify exists). |
| `POST /api/tasks/:id/cancel` | Cancel pending/running task. | Exists; verify works for running tasks. |
| `POST /api/tasks/:id/approve` | Approve a destructive action. | New for M4. |
| `POST /api/tasks/:id/reject` | Reject a destructive action. | New for M4. |
| `GET /api/checkpoints/:id/diff` | Show file diff at a checkpoint. | Optional for M6. |
| `GET /api/checkpoints/:id/files` | List files at a checkpoint. | Optional for M6. |

All changes should be additive and must not break existing control-plane tests.

---

## 7. File migration map

| Current file | New / merged into | Notes |
|--------------|-------------------|-------|
| `packages/ui/src/App.tsx` | Refactored to app shell + `Router` | Keep state providers here. |
| `packages/ui/src/main.tsx` | Minimal bootstrap | Import global CSS only. |
| `packages/ui/src/CostDashboard.tsx` | `packages/ui/src/views/CostsView.tsx` | Add charts. |
| `packages/ui/src/TraceView.tsx` | `packages/ui/src/views/TraceView.tsx` | Add interactivity. |
| `packages/ui/src/TimeTravelView.tsx` | `packages/ui/src/views/TimeTravelView.tsx` | Add tree + diff. |
| `packages/ui/src/CiHealView.tsx` | `packages/ui/src/views/CiHealView.tsx` | Add actions. |
| `packages/ui/src/DeadLetterView.tsx` | `packages/ui/src/views/DeadLetterView.tsx` | Add dialog. |
| `packages/ui/src/CleanupView.tsx` | `packages/ui/src/views/CleanupView.tsx` | Add confirmations. |
| New files | `packages/ui/src/components/base/*`, `packages/ui/src/components/Terminal.tsx`, `TaskList.tsx`, `Sidebar.tsx`, `RunView.tsx`, `TasksView.tsx`, hooks, utils. | Majority of the work. |

---

## 8. Testing and QA

1. **Static checks:** Run `pnpm lint`, `pnpm typecheck`, `pnpm --filter ui build` after every milestone.
2. **Unit tests:** Add minimal component tests only where logic is complex (e.g., event filtering, status mapping).
3. **Integration tests:** The control-plane test failure (`server.test.ts` heal-attempt message mismatch) must be fixed before M4 if it touches approval/cancel endpoints.
4. **Manual smoke tests:**
   - Start control plane + UI.
   - Trigger `Fix failing-sum test`.
   - Watch terminal, then open Trace and Time Travel.
   - Refresh the page mid-run; confirm terminal resumes/replays.
   - Cancel a running task.

---

## 9. Risks and mitigation

| Risk | Mitigation |
|------|------------|
| Base UI + Tailwind adds bundle size | Tree-shake Base UI; lazy-load heavy views (Trace/Time Travel). |
| Dark theme hurts readability | Use high-contrast text (`#f5f5f5` on `#0a0a0a`), avoid pure black, test at low brightness. |
| Refactor breaks existing UI tests | Update or replace UI tests incrementally; keep `App.tsx` routing backward-compatible. |
| New approval endpoints require backend work | Implement M4 only after backend endpoints land or do frontend stubs behind a feature flag. |
| Real-time event stream is hard to test | Add a manual `/api/tasks/:id/events` replay mode and a mock SSE fixture for development. |

---

## 10. Definition of done

- The UI is a single dark-themed React + Base UI + Tailwind app with a sidebar layout.
- All views are accessible, responsive, and keyboard-friendly.
- All functional UI bugs described in the current-state section are fixed.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter ui build` pass.
- A manual end-to-end run demonstrates: trigger → terminal → trace → time travel → costs without leaving the UI.
