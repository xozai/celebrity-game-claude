# Contributing to Celebrity Game (Server)

Thank you for contributing! This document covers the conventions required for
automated releases to work correctly.

---

## Commits and Releases

This repository follows **[Conventional Commits](https://www.conventionalcommits.org/)**
and uses **[release-please](https://github.com/googleapis/release-please)** to automate
versioning and changelogs.

### How it works

1. Every PR to `main` is **squash-merged**. The PR title becomes the commit message.
2. On every push to `main`, release-please inspects the commit log, determines the next
   SemVer version, and opens (or updates) a **"Release PR"**.
3. When you merge the Release PR, a GitHub Release + git tag are created automatically.

### Versioning rules (pre-1.0)

| Commit type | Version bump |
|---|---|
| `feat:` | **MINOR** — `0.x.0 → 0.(x+1).0` |
| `fix:`, `perf:`, `refactor:` | **PATCH** — `0.x.y → 0.x.(y+1)` |
| `feat!:` or `BREAKING CHANGE:` footer | **MINOR** — same as `feat` while pre-1.0 |
| `chore:`, `docs:`, `ci:`, `test:`, `style:`, `build:` | no bump (changelog hidden) |

> Once the project graduates to 1.0, breaking changes will become MAJOR bumps.

### PR title format

```
<type>[optional scope]: <short description>
```

The subject must not start with an uppercase letter. The linter enforces this
automatically on every PR.

#### ✅ Good PR titles

```
feat: add QR code invite screen
fix: prevent host button from disappearing after reconnect
feat(lobby): show minimum-player warning before game start
feat!: rename join_room event to player_join (breaking API change)
perf: reduce round-trip latency by caching room state
docs: update README with self-hosting instructions
chore: bump socket.io to 4.7
refactor: extract turn logic into separate module
```

#### ❌ Bad PR titles

```
Update stuff                    # no type
Fix bug                         # no type, uppercase subject
Feat: Add QR code               # uppercase type
fixed the reconnect bug         # missing type prefix
feature/qr-code                 # branch name, not a commit message
```

### Allowed types

| Type | When to use |
|---|---|
| `feat` | New user-visible feature |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code change with no behaviour change |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Maintenance, dependency bumps, tooling |
| `ci` | CI/CD pipeline changes |
| `style` | Formatting, whitespace (no logic change) |
| `build` | Build system or bundler changes |

### Scopes (optional)

Scopes are optional but encouraged for clarity:

```
feat(lobby): ...
fix(timer): ...
refactor(socket): ...
```

### Breaking changes

Mark breaking changes with `!` after the type or with a `BREAKING CHANGE:` footer:

```
feat!: rename join_room to player_join

# or with a footer:
feat: new team assignment algorithm

BREAKING CHANGE: teams are now assigned server-side; client must not send team data
```

---

## Development workflow

1. Fork or branch off `main`.
2. Make your changes.
3. Open a PR with a Conventional Commits title.
4. Pass review + CI.
5. Maintainer squash-merges — the PR title becomes the commit message.
