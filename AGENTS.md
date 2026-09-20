# privaproxy Project Instructions

## Project Overview

privaproxy is a self-hosted privacy-focused web platform built with Node.js and Express.

It currently provides:

* A web proxy/browser using Ultraviolet and Scramjet.
* A private, ad-free YouTube client.
* YouTube search and video metadata through yt-dlp.
* HLS video playback through hls.js.
* Server-side HLS playlist and segment proxying.
* Pluggable proxy backends.
* Client-side browser proxy engines.

The project is intended for legitimate privacy, development, and educational use.

## Technology

* Node.js
* Express
* JavaScript
* HTML/CSS
* hls.js
* yt-dlp
* Ultraviolet
* Scramjet
* Bare server infrastructure
* Git/GitHub

## Important Project Structure

* `server/index.js` - Main Express server.
* `server/proxies/` - Proxy backend implementations.
* `server/proxies/providerInterface.js` - Proxy provider interface.
* `server/proxies/registry.js` - Proxy provider registry.
* `server/youtube/` - YouTube backend.
* `server/youtube/routes.js` - YouTube API routes.
* `server/youtube/ytdlp.js` - yt-dlp integration.
* `server/youtube/hls.js` - HLS processing and proxying.
* `public/index.html` - Main frontend.
* `public/js/app.js` - Main frontend application logic.
* `public/js/youtube.js` - YouTube client.
* `public/uv/` - Ultraviolet frontend assets/configuration.
* `public/scramjet/` - Scramjet frontend assets/service worker.
* `public/css/` - Frontend styles.
* `server/config/proxies.json` - Proxy configuration.

## Development Rules

* Inspect the existing code before making changes.
* Prefer small, focused changes over large rewrites.
* Preserve existing architecture unless there is a concrete reason to change it.
* Do not remove working functionality without discussing why.
* Reuse existing modules and utilities when practical.
* Keep frontend and backend responsibilities separated.
* Do not add unnecessary dependencies.
* Do not commit generated files, secrets, credentials, API keys, or private configuration.
* Never put `.env` contents, tokens, passwords, or credentials into Git.
* Do not expose private development services publicly without explicit instruction.

## Security

This project handles proxy requests and remote content, so security is important.

Pay particular attention to:

* SSRF prevention.
* URL validation.
* Request validation.
* Authentication and authorization where needed.
* Rate limiting.
* Resource exhaustion.
* Arbitrary file access.
* Command injection.
* Unsafe yt-dlp arguments.
* Malicious or unexpected HLS URLs.
* Open proxy abuse.
* Sensitive information in logs.

Do not weaken existing security controls just to make a feature easier to implement.

If a requested change introduces a significant security risk, explain the risk before implementing it.

## YouTube

The YouTube client uses yt-dlp for search/video metadata and HLS-related processing.

When modifying YouTube functionality:

* Preserve the existing API structure where possible.
* Keep HLS playlist rewriting compatible with the existing player.
* Preserve caching and concurrency protections unless there is a specific reason to change them.
* Do not implement DRM circumvention.
* Do not attempt to bypass authentication, access controls, or other protected systems.

## Proxy Engines

The browser proxy currently supports Ultraviolet and has Scramjet integration.

When modifying proxy-engine functionality:

* Preserve the existing per-tab architecture.
* Do not break service-worker registration.
* Do not silently remove an engine from the UI.
* Keep proxy providers modular.
* Validate remote URLs and inputs appropriately.
* Be especially careful with SSRF and open-proxy behavior.

## Testing and Verification

After making a change:

1. Inspect the diff.
2. Run the relevant tests or verification commands.
3. Check for syntax/runtime errors.
4. Verify that unrelated functionality was not changed.
5. Use `git status` and `git diff` before committing.

If there are no automated tests for the affected area, perform a focused manual verification and explain what was checked.

Do not claim that something was tested if it was not actually tested.

## Git Workflow

Git is the project's source-control system.

### Before making changes

Check:

```bash
git status
```

Review recent history when useful:

```bash
git log --oneline -10
```

### After making changes

Always inspect:

```bash
git status
git diff
```

Before committing, make sure:

* Only intended files changed.
* No secrets or credentials are included.
* No unrelated changes are included.
* The relevant tests or verification steps passed.

### Commits

OpenCode is allowed to create commits for completed work.

Create a commit when a requested change is complete and has been verified.

Use concise, descriptive commit messages, for example:

```text
Add Scramjet provider registration
Fix YouTube HLS segment proxying
Improve proxy URL validation
Add latency checks for proxy providers
```

Do not create meaningless commits such as:

```text
changes
update
stuff
fix
test
```

Do not create a commit for every tiny intermediate edit. Prefer one coherent commit per completed task or logical change.

### GitHub Remote

The repository has a GitHub remote.

Local commits should remain local until they have been reviewed.

**Do not push to GitHub automatically.**

Before pushing:

1. Confirm the working tree is clean.
2. Confirm the intended commits are present.
3. Review the commits that would be pushed.
4. Ask the user for permission to push.

Use:

```bash
git status
git log --oneline origin/main..HEAD
```

to review commits that have not yet been pushed.

Only run:

```bash
git push
```

after the user explicitly approves the push.

### Git Destructive Operations

Do not automatically perform destructive Git operations.

Ask before using commands such as:

```text
git reset --hard
git clean
git checkout -- .
git restore .
git rebase
git branch -D
git push --force
git push --force-with-lease
```

Never force-push unless the user explicitly requests it.

## GitHub

Treat GitHub as the remote/public copy of the project.

Local development and commits can happen automatically, but publishing changes to GitHub requires user approval.

When asked to push:

* Verify the remote first if necessary.
* Review the commits being pushed.
* Push only the intended branch.
* Report the result clearly.

Do not create, delete, merge, or modify GitHub branches, pull requests, issues, releases, or repository settings unless the user explicitly asks for that action.

## Agent Behavior

When given a development task:

1. Understand the request.
2. Inspect relevant files.
3. Explain the plan briefly if the task is complex.
4. Make the smallest reasonable changes.
5. Test or verify the changes.
6. Review the Git diff.
7. Commit completed work when appropriate.
8. Do not push to GitHub without explicit user approval.
9. Summarize what changed and what was tested.

If something is ambiguous, inspect the repository first rather than guessing.

If a change could have significant architectural or security consequences, stop and explain the issue before making the change.
