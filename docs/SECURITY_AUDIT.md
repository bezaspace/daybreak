# Security Audit — Phase 6 M6

This document captures the security gaps identified and the mitigations added in Phase 6 Milestone 6.

## Findings

1. **Path traversal in file tools**
   - The agent could request `read`/`write`/`edit` with `path: "../.env"` or an absolute path outside the workspace.
   - Mitigation: `sanitizePath(cwd, requestedPath)` resolves the path and rejects anything that contains `..` or resolves outside `cwd`.

2. **Path traversal in `bash` commands**
   - Commands like `cat /etc/passwd` or `cat ../.env` could leak host files.
   - Mitigation: `SafetyMiddleware` tokenizes `bash` commands, treats path-like tokens as candidate paths, and runs `sanitizePath` and `isSensitivePath` on each.

3. **Secrets leaked in event streams and logs**
   - LLM tool outputs, CI logs, and control-plane events could contain `GITHUB_TOKEN`, `api_key`, PEM blocks, URL credentials, or `Authorization` headers.
   - Mitigation: `redactSecrets()` is applied in `agent-runner/src/stream.ts`, `control-plane/src/server.ts` (`appendLog` and `publishEvent`), and reused by `control-plane/src/ci-logs.ts`.

4. **Protected-branch bypasses**
   - `git switch main`, `git merge main`, `git push origin :main`, and `git push origin --delete main` were not caught by the original branch-protection logic.
   - Mitigation: `parseGitBranchArg` now includes patterns for `git switch`, `git merge`, refspec deletions, and `--delete`.

5. **Denylist too narrow**
   - Files such as `.aws/credentials`, `.docker/config.json`, `.netrc`, `.pgpass`, `.my.cnf`, `id_rsa`, `id_ed25519`, `*.p8`, `*.mobileprovision`, and shell histories were not covered.
   - Mitigation: `DEFAULT_DENYLIST_PATTERNS` in `packages/shared/src/config.ts` was extended with these entries.

## Verification

- `sanitizePath` unit tests cover workspace-relative paths, `..` traversal, and absolute paths outside the workspace.
- `redactSecrets` unit tests cover URL credentials, `api_key`/`token` values, GitHub tokens, `Authorization`/`Bearer` headers, PEM blocks, and AWS access keys.
- `SafetyMiddleware` tests verify that `read ../.env`, `cat /etc/passwd`, `cat /home/user/target/.env`, and `git push origin main` are blocked.
