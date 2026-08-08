# Local Mode Strategy

**Goal:** Run Daybreak entirely on a developer's machine during testing, eliminating free-tier usage of E2B, Supabase Cloud, Upstash, and Langfuse.

## Concept

A single **Cloud / Local** toggle selects the whole backend package.

- **Cloud mode:** Uses the existing hosted services (E2B, Supabase Cloud, Upstash, Langfuse).
- **Local mode:** Uses self-hosted alternatives orchestrated with Docker Compose.

The toggle is a package switch, not a per-service menu. Cloud mode stays the default so existing behavior is unaffected.

## Replacement map

| Cloud service | Local replacement |
|---|---|
| E2B sandbox | Den |
| Supabase Cloud | Supabase Local CLI |
| Upstash Redis | Local Redis + UpRedis REST proxy |
| Langfuse Cloud | Arize Phoenix (self-hosted) |

## Milestones

Each milestone is independently testable and leaves cloud mode untouched. Pick them one at a time.

1. **Mode package toggle**  
   Add a `cloud | local` mode switch in configuration and the UI. Existing cloud paths keep working exactly as before.

2. **Local observability**  
   Replace Langfuse Cloud with Arize Phoenix in local mode. All OpenTelemetry traces must flow to the local Phoenix instance; Langfuse Cloud is not used locally.

3. **Local event stream**  
   Replace Upstash Redis with a local Redis + UpRedis-compatible REST proxy in local mode. Verify real-time task streaming still works.

4. **Local persistence**  
   Replace Supabase Cloud with Supabase Local CLI in local mode. Apply existing migrations and verify task/event storage.

5. **Local sandbox**  
   Replace E2B with Den in local mode. Run an end-to-end task without spending E2B credits.

6. **Local Docker Compose stack**  
   Provide one command that starts all local services together. Document how to switch between cloud and local.

7. **Final verification**  
   Run lint, typecheck, tests, and a full local-mode task. Update the environment blueprint so future sessions boot with the local stack ready.

## Guiding principles

- Cloud mode remains the default.
- Each provider is swappable behind the mode switch without rewriting core logic.
- Keep existing APIs, SDKs, and migrations; only change endpoints or credentials.
- Prefer mature, open-source, self-hostable tools.
- Avoid hard-coding ports, paths, or timeouts in the strategy; let the implementation agent choose sensible defaults.

## Open questions

- Den is the first-choice sandbox; Daytona is the fallback if Den proves immature.
- Exact CPU/RAM/disk requirements for the full local stack on a laptop.
