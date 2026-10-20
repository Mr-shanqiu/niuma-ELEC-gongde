# Project ownership and workspace rules

These rules supplement the user's global goal-watchdog and persistent-SSH instructions.

## Canonical project

- The canonical root is `/Users/yue/Desktop/牛马电子功德`.
- Start with `PROJECT_HOME.md`. Product code belongs to this root, not the legacy ChatGPT directory or an unrelated repository.
- Always specify the canonical working directory for shell commands. A legacy compatibility entry is not a second checkout.
- Preserve existing user changes. Do not migrate repositories, replace frozen artifacts, rewrite history, run tests, or deploy merely to organize files.

## Work materials

- New local scratch work belongs under `.local-work/acceptance`, `.local-work/candidates`, `.local-work/handoffs`, or `.local-work/archive`.
- `.local-work/INDEX.md` records ownership and references. It is an inventory, not a replacement goal registry, watchdog or product database.
- Continue using the official goal registry and the existing authorized durable checkpoint. Do not create another checkpoint system to implement this layout.
- Keep product rules and release facts in their existing authoritative documents.
- Existing frozen and path-checked temporary artifacts retain their original paths until a separately planned migration preserves their constraints and receipts.
- Do not copy credentials, raw private payloads or unredacted logs into public documentation or Git. Do not automatically commit local work materials.
- After product work resumes, assign agents explicit paths under this project. Existing shared-infrastructure assignments retain their actual external owner and boundary.

## Shared infrastructure

- The existing Gongde deployment tools in the ACE worktree are external shared-infrastructure dependencies. Do not move or edit them as part of project housekeeping.
- Shared server access must use the approved alias, access wrapper, persistent SSH connection and existing checkpoint. Directory ownership does not grant production or credential access.
- Do not interrupt the billiards product or change running services to tidy local files.

### What access actually exists (2026-10-20)

Recorded because the earlier version of this file implied `deploy-gongde` was the
only way in, which led an agent to report infrastructure work as impossible.

- `deploy-gongde` (in `~/.local/bin`) is the **site release** channel only. It
  streams a frozen archive and the server accepts nothing but that: archive
  members are limited to fixed root files and `assets/*`, and the remote side
  runs a fixed `deploy <tree_sha> <archive_sha>` handler. It cannot edit server
  configuration, and `Caddyfile` is not an allowed archive member.
- A direct SSH login **does** exist and **does** reach the host: use the alias
  `ace-zqscreen-dev` (details live in `~/.ssh/config`; do not copy the host,
  user or key path into this file or into Git). The login is placed in the
  `sudo` group. Read-only inspection such as `hostname`, `id`, `pgrep`, and
  `command -v` works with plain `ssh ace-zqscreen-dev "<command>"`.

Status of that login depends on what the user has authorised for the current
task. Having the ability is not the same as having permission: production
configuration changes need the user to name the change explicitly.

### Host layout facts

- The public site is served by Caddy running as `caddy-unprivileged` with
  `--config /etc/caddy/Caddyfile`. `/etc/caddy/Caddyfile` is not project-owned.
- The host also serves unrelated products. Any change to shared configuration
  affects them, so treat it as a fleet-wide change rather than a Gongde change.

### Boundaries when touching the shared host

- Never read, print or diff credential stores: `~/.ssh/authorized_keys`, private
  keys, `.env` files, or `sudo` configuration. Diagnosing access does not
  require opening them.
- Back up `/etc/caddy/Caddyfile` before editing, run
  `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, and then
  reload rather than restart, so other products keep serving.
- Prefer narrower changes: a `handle`/`header` matcher for a specific host or
  path prefix, never a global `header` that reaches every site on the box.
- Cache rule intent for the Gongde site: HTML stays `no-cache` (it carries the
  release revision); content-hashed `assets/runtime/<64hex>/…` may be served
  `immutable`; public catalogue APIs may be briefly cacheable, but anything
  carrying order, claim or session state must stay `private, no-store`.
