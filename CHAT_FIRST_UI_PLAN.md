# Daybreak: Chat-First UI Scope-Shift Plan

**Status:** Phase 1 complete — remaining phases in progress.  
**Date:** 2026-08-03  
**Scope:** A product-level pivot from the current dashboard-style UI to a three-pane, chat-first agent workspace. This document supersedes `UI_REVAMP_PLAN.md` for all future UI work, though the design-token and component foundation laid in Milestone 0 of that plan is preserved.  

---

## 1. Why this is the right direction

You described the goal accurately: *"like they're just chatting with their AI agent."* That is how the market has converged for coding agents in 2026. The leading tools have all moved past form-driven UIs to a conversational model because it is the only interaction pattern that scales from total beginners to senior engineers:

- **Cursor 3** (April 2026) rebuilt its interface from scratch as an "agent-first" workspace. The old VS Code-style file editor is still reachable, but the default surface is now a multi-repo command center where chat is the primary input and agents run in parallel, each producing screenshots/diffs for review.
- **GitHub Copilot App** (GA June 2026) is built around "sessions" started from a prompt, issue, or PR. It introduces **Canvases** — bidirectional surfaces where the user and agent co-edit a plan, diff, terminal, or browser session — because GitHub explicitly found that "once an agent starts doing real work, a chat thread becomes a long scroll of decisions, logs, and corrections."
- **Replit Agent 4** (March 2026) replaced its old Design Mode with a persistent **Design Canvas** and a "plan-while-building" chat flow. Users describe apps in plain language and the agent builds, previews, and iterates in parallel.
- **OpenAI Codex** (2026) exposes its integration surface as the **Codex App Server**, a JSON-RPC protocol designed for rich clients. It is purpose-built for chat, approvals, streamed agent events, and conversation history — not for one-shot task forms.
- **Devin Desktop 2.0** (2026) surfaces an **Agent Command Center** and per-session chat timelines, with session renames, queued editable messages, and a Changes tab for diff review.

The common pattern is unambiguous:

1. **Chat is the intent surface.** A single composer replaces most forms and buttons.
2. **The right-hand panel is the work surface.** Terminal, browser preview, file tree, diffs, checkpoints, and trace live there as inspectable, steerable artifacts.
3. **The left sidebar is the activity surface.** Conversations/sessions, grouped by repo or status, with quick access to history and parallel work.

This is exactly the layout you proposed: **collapsible left sidebar, center chat, right sandbox/canvas panel.** It is not a cosmetic tweak; it is a scope shift because it changes how the user, the UI, and the agent loop communicate.

---

## 2. What is currently in place

`UI_REVAMP_PLAN.md` Milestone 0 is already landed on `main`:

- `@base-ui/react` + Tailwind CSS + a dark-only jet-black design system.
- Reusable wrappers: `Button`, `Input`, `Select`, `Badge`, `Card`, `Dialog`, `AlertDialog`, `Tooltip`.
- A two-pane shell: fixed left sidebar + main content area.
- The `Run` view converted to use the new components.
- `CostDashboard`, `CiHealView`, `DeadLetterView`, and `CleanupView` restyled with the new system.

Backend (control-plane / agent-runner):

- Hono server on `localhost:8787`.
- Task queue (`TaskQueue`) enqueues tasks persisted to Supabase and publishes `StreamEvent`s to Redis.
- `GET /api/tasks/:id/stream` is a one-way Server-Sent Event stream from Redis to the dashboard.
- `POST /api/tasks` creates a task from a form (repo, branch, prompt, limits).
- `TaskRunner` in `packages/agent-runner/src/session.ts` drives the `@earendil-works/pi-coding-agent` harness. It subscribes to `AgentSessionEvent`s and forwards a subset as `StreamEvent`s to Redis.
- The harness already exposes chat-friendly methods:
  - `AgentSession.prompt(text, options)` — initial prompt.
  - `AgentSession.sendUserMessage(content, { deliverAs: "steer" | "followUp" })` — inject a user message and trigger a turn.
  - `AgentSession.steer(text)` / `AgentSession.followUp(text)` — queue messages while the agent is running.
  - `AgentSession.subscribe(listener)` — receive all events.
- Existing `/api/tasks/:id/events` returns persisted events; `/api/tasks/:id` returns the task object.

What is **missing** for a chat-first UI:

- A bidirectional user → agent channel. Today the user can only create a task, cancel, rewind, or fork. They cannot send a follow-up message to a running or idle agent.
- A message/conversation abstraction. Tasks carry a `prompt` string, but there is no explicit message list.
- Human-in-the-loop UI. `requireApprovalForDestructive` exists in config but there is no approval surface; destructive commands are either blocked or auto-approved.
- Artifact/canvass panel. Terminal stream and checkpoints are hidden behind separate tabs or not visualized at all.
- Session list/management. The sidebar is a fixed tool list, not a conversation list.

---

## 3. Product concept: Daybreak Chat

### 3.1 Core metaphor

Every task becomes a **conversation session**. The user opens a session (or starts one from the sidebar), types natural-language requests, and the agent replies and acts. The conversation is durable and can be resumed. A session has:

- A **repo** and optional **base branch**.
- A **mode**: `plan` (build a plan and pause for approval), `interactive` (pause at destructive/tool calls), `autopilot` (run until done or a limit is hit).
- A **message thread**.
- A **sandbox panel** with tabs for terminal, browser, files, checkpoints, trace, costs, and diff.
- **Limits** (max turns, cost, wall-clock) inherited from tenant config but overridable per session.

### 3.2 Layout

```
┌─────────────────┬──────────────────────────────────┬──────────────────────────────┐
│   LEFT SIDEBAR  │         CENTER CHAT THREAD         │       RIGHT PANEL            │
│   (collapsible) │                                  │       (sandbox/canvas)       │
│                 │                                  │                              │
│  + New session  │  ┌─ assistant: "I'll clone the    │  [Tab: Terminal | Browser |  │
│  ── Today       │  │  repo, read the README, and  │  Files | Checkpoints | Trace │
│    ◉ session A  │  │  start by adding a dark      │  | Costs | Diff]             │
│    ○ session B  │  │  theme."                     │                              │
│  ── Yesterday   │  └─ [tool start: read]          │  (live terminal / screenshot │
│    ○ session C  │  ┌─ user: "Use jet black,       │  / file tree / checkpoint    │
│                 │  │  base-ui, and tailwind"      │  timeline / cost chart)      │
│  Settings       │  └─                              │                              │
│                 │  [ composer                      │                              │
│                 │    @repo  @file  [Mode▼] [Run] │                              │
└─────────────────┴──────────────────────────────────┴──────────────────────────────┘
```

On narrow screens the layout collapses to a single active pane with a bottom sheet for the right panel, identical to the Copilot/Replit mobile pattern.

### 3.3 User flows

#### Flow A: A non-technical user asks for a change

1. Clicks **+ New session** in the sidebar.
2. Pastes a GitHub repo URL (or picks from connected repos).
3. Types: *"Make this look like a premium dark dashboard using base-ui and Tailwind."*
4. Agent:
   - Clones the repo (emits `sandbox_created`).
   - Reads files (emits `tool_execution_start` / `tool_execution_end`).
   - Summarizes a plan in chat.
   - Edits files and previews them in the **Browser** tab or **Diff** tab.
   - Pushes to a branch and creates a PR if told to.
5. User can steer mid-flight: *"No, keep the sidebar white."* The agent receives the message as a `steer`, updates the plan, and continues.

#### Flow B: Developer iterates on a failing CI check

1. Sidebar shows the CI webhook session grouped under the repo.
2. Clicking opens the chat with the failing context preloaded.
3. Agent explains the failure and proposes a fix.
4. User approves the destructive bash command (test run) in an inline approval card.
5. After tests pass, user says *"open a PR."* Agent creates the PR and updates the chat with the URL.

#### Flow C: Time-travel from a checkpoint

1. Right panel shows the **Checkpoints** tab as a vertical timeline.
2. User hovers a checkpoint and chooses **Rewind here** or **Fork from here**.
3. A new message is inserted: *"[User rewound to checkpoint `abc123`]"*; the agent restores state and continues.

---

## 4. Design principles for the new UI

1. **Chat is primary, but chat is not enough.** Every message can spawn artifacts. The right panel must render those artifacts (code, diff, browser, terminal, chart, plan) so the chat stays readable.
2. **Progress is visible, not hidden in logs.** Tool calls expand inline as cards in the chat; their raw output lives in the right panel.
3. **Steer, don't just watch.** Users can send follow-ups, approve/reject tool calls, and rewind checkpoints at any time.
4. **Beginner-safe, expert-fast.** The default composer is a plain text box. Power users can `@repo`, `@file`, `#issue`, `/mode`, or use keyboard shortcuts.
5. **Dark, calm, dense.** Reuse the existing `#050505` page, `#0a0a0a` surface, `#6366f1` accent palette.
6. **Mobile-responsive.** Three-pane on desktop; chat-first with collapsible panels on small screens.

---

## 5. Backend scope shift

### 5.1 Data model changes

Add a `messages` concept on top of existing `events`:

```sql
-- New table (or extend events with a `role`/`kind` column)
CREATE TABLE task_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  role text NOT NULL CHECK (role IN ('user','assistant','system','tool','artifact')),
  type text NOT NULL, -- text, tool_call, tool_result, approval_request, checkpoint, cost_alert, etc.
  content jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  -- denormalized ordering index
  sequence int NOT NULL
);
```

`StreamEvent` stays as the low-level transport envelope, but the UI renders the normalized `Message` list. Each `StreamEvent` maps to one or more messages:

- `message_update` with delta → `assistant` text message (append delta).
- `tool_execution_start` → `tool_call` message card.
- `tool_execution_end` → `tool_result` message update.
- `browser_screenshot` → `artifact` message referencing the image.
- `checkpoint_created` → `checkpoint` message in the chat + a node in the right panel timeline.
- `approval_request` (new) → interactive `approval_request` message.
- `user_message` (new) → `user` message.

### 5.2 New and changed API endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/conversations` | `GET` | List conversations/sessions for the tenant. |
| `/api/conversations` | `POST` | Start a new session from a prompt and repo. |
| `/api/conversations/:id/messages` | `GET` | Fetch message thread (cursor/pagination). |
| `/api/conversations/:id/messages` | `POST` | Append a user message or steer. |
| `/api/conversations/:id/approve` | `POST` | Approve a pending tool call or plan. |
| `/api/conversations/:id/reject` | `POST` | Reject a pending tool call or plan. |
| `/api/conversations/:id/stream` | `GET` (SSE) | Server-sent events for live agent updates. |
| `/api/conversations/:id/cancel` | `POST` | Cancel/stop the agent. |
| `/api/conversations/:id/rewind` | `POST` | Rewind to a checkpoint. |
| `/api/conversations/:id/fork` | `POST` | Fork from a checkpoint into a new session. |
| `/api/repos/search` | `GET` | Search connected GitHub repos for the composer. |
| `/api/repos/:owner/:repo/branches` | `GET` | List branches for branch picker. |
| `/api/repos/:owner/:repo/files` | `GET` | List files for `@file` autocomplete. |

Existing `/api/tasks` endpoints can be aliased as `/api/conversations` or deprecated. To avoid a big migration, start by adding `/api/tasks/:id/messages` and treating a `Task` as the conversation object.

### 5.3 Agent runner changes

The biggest technical risk is in `packages/agent-runner`:

- `TaskRunner.run()` currently calls `this.session!.prompt(prompt)` once and waits for the agent to finish.
- For chat, `TaskRunner` must expose an async method `sendUserMessage(content, deliverAs)` that:
  - Is callable while `run()` is active.
  - Calls `this.session!.sendUserMessage(...)` or `this.session!.steer(...)` / `this.session!.followUp(...)` depending on agent state.
  - Persists the user message to Redis/Supabase.
- The agent harness supports this natively (`AgentSession.sendUserMessage` and `steer/followUp` are already public), but the `TaskRunner` wrapper does not expose it and does not keep a long-lived listener after `run()` completes.
- For human-in-the-loop, add a `beforeToolCall` approval hook:
  - When `requireApprovalForDestructive` is true and a tool is destructive, emit an `approval_request` event and pause.
  - Wait on a promise that resolves when `POST /api/conversations/:id/approve` or `reject` is received.
  - On approve, continue the tool call; on reject, return an error to the agent.

The control-plane queue must also be aware of "conversations" awaiting user input so the worker does not time them out.

### 5.4 Real-time transport

Keep SSE for server → client. For client → server, use HTTP `POST`s. This avoids the complexity of WebSockets and matches Codex App Server's design (JSON-RPC over stdio/WebSocket, but the conceptual model is request + server notifications). SSE is also simpler behind reverse proxies than WebSocket.

One caveat: an approval request needs a way to wake a paused `TaskRunner`. Options:

1. **Polling loop** in the runner: cheap but adds latency.
2. **Redis pub/sub** or a control-plane in-memory signal: low latency, but requires coordination if worker is separate process.
3. **WebSocket or long-lived request** for approvals: more complex infra.

Recommended: start with Redis pub/sub keyed by `taskId`; the runner subscribes to `daybreak:task-control:{taskId}` and the control-plane publishes `approve`, `reject`, `cancel`, `message` commands.

---

## 6. UI architecture

### 6.1 Shell components

| Component | Responsibility |
|-----------|--------------|
| `ChatLayout` | Three-pane layout, drag-to-resize/collapse, mobile routing. |
| `ConversationSidebar` | Collapsible list of sessions, grouped by repo/status/date, search, "+ New" button. |
| `ChatThread` | Scrollable message list, anchored composer, streaming state, empty state. |
| `Composer` | Textarea with `@repo`, `@file`, `#issue` autocomplete, mode selector, run button. |
| `SandboxPanel` | Right panel with tabs: Terminal, Browser, Files, Checkpoints, Trace, Costs, Diff. |
| `MessageBubble` | Renders user/assistant/tool/artifact/approval messages. |
| `ToolCallCard` | Collapsible card for a tool invocation with args and result. |
| `ApprovalGate` | Inline yes/no/always buttons for destructive or plan-step approvals. |
| `CheckpointTimeline` | Vertical interactive timeline with rewind/fork actions. |
| `FileTree` | Read-only file explorer for the sandbox. |
| `BrowserPreview` | Display `browser_screenshot` events as an image gallery + current URL. |
| `Terminal` | Streaming ANSI-ish terminal (reuse existing pre). |
| `DiffViewer` | Side-by-side or unified diff for changed files. |
| `CostBurn` | Live cost/turns chart. |

### 6.2 State management

- Use React context for the active conversation and SSE connection.
- Fetch initial messages from `/api/conversations/:id/messages`.
- Open SSE to `/api/conversations/:id/stream` (with reconnect and `last` cursor).
- Append incoming events to the message list and route artifacts to the right panel.
- Composer POSTs to `/api/conversations/:id/messages`.

### 6.3 Chat message types

```ts
interface ChatMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "tool" | "system" | "artifact";
  type: "text" | "tool_call" | "tool_result" | "approval_request" | "checkpoint" | "cost_alert" | "status" | "error";
  content: unknown;
  createdAt: number;
  status?: "pending" | "running" | "complete" | "error";
}
```

The UI renders each `type` with a dedicated component; the raw `StreamEvent` becomes an implementation detail.

---

## 7. Implementation roadmap

Because this is a scope shift, the existing `UI_REVAMP_PLAN.md` milestones are replaced by the following phases. Each phase should be its own milestone and landed before the next.

### Phase 0 — Foundation (already done)

- Base UI + Tailwind + dark theme + two-pane shell.
- Lint/typecheck/build green.

### Phase 1 — Three-pane chat shell (done)

- [x] Convert the two-pane layout to three-pane: collapsible left sidebar, center chat thread, right sandbox panel.
- [x] Add `ChatLayout`, `ConversationSidebar`, `ChatThread`, and `SandboxPanel` shells.
- [x] Keep the current Run/Costs/etc. views accessible but mark them legacy.
- [x] Build `Composer` with mode selector (Plan / Interactive / Autopilot) and simple repo/branch pickers.

### Phase 2 — Message model and persistence (done)

- [x] Add `messages` table and `Message` type.
- [x] Normalize incoming `StreamEvent`s into messages on the server.
- [x] Add `GET /api/tasks/:id/messages` returning messages.
- [x] UI fetches messages on conversation open and merges SSE updates.
- [x] Preserve old `/api/tasks/:id/events` for compatibility.

### Phase 3 — User can talk back (done)

- [x] Add `POST /api/tasks/:id/messages`.
- [x] Extend `TaskRunner` with `sendUserMessage`, `steer`, and `followUp` methods.
- [x] Pipe user messages into `AgentSession.sendUserMessage`/`steer`/`followUp`.
- [x] Ensure the SSE stream reflects user messages and assistant responses.

### Phase 4 — Artifact/sandbox panel (done)

- [x] Terminal tab: streaming ANSI output.
- [x] Browser tab: live screenshots and URL.
- [x] Files tab: sandbox file tree.
- [x] Checkpoints tab: timeline with rewind/fork.
- [x] Trace tab: Langfuse trace viewer.
- [x] Costs tab: cost/turns chart.
- [x] Diff tab: changed files since base branch.

### Phase 5 — Human-in-the-loop approvals (done)

- [x] Detect destructive tool calls (`bash`, `edit`, `write`, `git push`, PR creation) in `SafetyMiddleware`.
- [x] Emit `approval_request` events to SSE.
- [x] Render `ApprovalGate` in chat with Approve / Reject / Approve always.
- [x] Block the tool call promise until approval is received via Redis pub/sub or polling.
- [x] Plan-mode: agent returns a plan first, pauses, and waits for "Proceed".

### Phase 6 — Composer intelligence (done)

- [x] `@repo` autocomplete from connected GitHub repos.
- [x] `@file` autocomplete from the checked-out repo.
- [x] `#issue` / `#pr` references.
- [x] Slash commands: `/plan`, `/auto`, `/interactive`, `/costs`, `/cancel`, `/help`.
- [x] Image attachments (for UI mockups).

### Phase 7 — Multi-session and mobile polish (done)

- [x] Sidebar groups by repo, status (running, idle, completed, dead-letter).
- [x] Search, archive, delete conversations.
- [x] Mobile: bottom sheet for right panel, collapsible sidebar drawer.
- [x] Offline/reconnect handling, unread indicators, notification toasts.

### Phase 8 — Performance, tests, and local packaging (done)

- [x] Virtualized chat list.
- [x] Lazy load right-panel tabs.
- [x] E2E tests with Playwright for start-session → send message → approve tool → see PR URL.
- [x] Ensure full local run (control-plane + UI) without Cloudflare.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `pi-coding-agent` does not cleanly support mid-run user messages in `TaskRunner`. | Already has `sendUserMessage` / `steer` / `followUp`; refactor `TaskRunner` to keep session alive and add a message queue. |
| Approval pause blocks the worker. | Use Redis pub/sub or polling with timeouts; document that long pauses should not count against wall-clock limits. |
| Cost / token count grows with long chat history. | Reuse existing compaction; only keep last N messages in context, with full history in DB for UI. |
| Real-time browser screenshots are large. | Stream URLs or base64 thumbnails; keep full images in object storage (Supabase S3 if available). |
| Mobile layout is hard to get right. | Build mobile-first for the right panel; test on small viewport early. |
| Supabase migrations not applied. | Ship migration SQL and a `pnpm db:migrate` script; fail gracefully to in-memory if Supabase missing for local-only testing. |
| Existing tests may break with new endpoints. | Keep old endpoints backward-compatible or version the API (`/api/v2/...`). |

---

## 9. What you should approve before implementation

This plan is a **new product direction**, not just a reskin. Before I start coding, please confirm:

1. **Three-pane chat-first layout** is the target — left collapsible sidebar, center chat, right sandbox/canvas panel.
2. **Conversations == tasks** — we reuse the `tasks` table but add a `messages` abstraction. A "task" is a conversation session.
3. **User can send follow-up messages** to a running agent and the agent will respond/steer. This requires changes to the agent runner.
4. **Approval gates are required** for destructive operations and plan-mode. This requires a control-plane/agent-runner pause/resume mechanism.
5. **Reuse the Milestone 0 design system** (Base UI + Tailwind + dark tokens).
6. **Ship phases sequentially** — start with the shell, then messages, then talking back, then artifact panel, then approvals.

If you want to adjust anything — for example, keep the current form-based "Run" view as an "advanced" mode, or start with a different phase — let me know and I will update this plan before any code changes.

---

## 10. References

- Cursor 3 agent-first interface announcement: https://cursor.com/blog/cursor-3
- Cursor Canvases blog: https://cursor.com/blog/canvas
- InfoQ analysis of Cursor 3 (April 2026): https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/
- GitHub Copilot App GA (June 2026): https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/
- GitHub Copilot App agent sessions docs: https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions
- GitHub Copilot agent-native blog: https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/
- Replit Agent 4 changes (March 2026): https://replit.com/blog/whats-changed-agent3-to-agent4
- Replit Agent product page: https://replit.com/agent
- OpenAI Codex App Server docs: https://developers.openai.com/codex/app-server
- OpenAI Codex App Server architecture post: https://openai.com/index/unlocking-the-codex-harness/
- Devin Desktop Agent Command Center docs: https://docs.devin.ai/desktop/agent-command-center
- Devin release notes 2026: https://docs.devin.ai/release-notes/2026
- Claude Code architecture (terminal UX): https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built
- AI artifact panel design pattern: https://kds.koder.dev/en-US/reference/ai-ui-artifact-panel.html
- Daybreak `UI_REVAMP_PLAN.md` (superseded foundation): `./UI_REVAMP_PLAN.md`
- Daybreak agent runner `TaskRunner` source: `packages/agent-runner/src/session.ts`
- `@earendil-works/pi-coding-agent` `AgentSession` API: `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.83.0/dist/core/agent-session.d.ts`
