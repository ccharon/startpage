# AGENTS.md

Notes for coding agents working in this repository. Overview for humans: [README.md](README.md).

## Project

Local bookmark start page: a Go binary serves a single page app on a loopback address. The data
lives in one JSON file. The main platform is Linux (XDG paths, systemd user service); Windows is
still supported through cross-builds.

## Commands

```bash
make check        # before every commit: gofmt check, go vet, go test
make test-js      # unit tests of the pure helpers in app.js (Node, no packages)
make e2e          # browser tests: real server and headless Chrome on free ports, throwaway data
make vulncheck    # govulncheck; also runs in CI and before every release
make              # bin/startpage-<os>-<arch> for this system
make dist         # all release binaries (linux-amd64, linux-arm64, windows-amd64[-noconsole]) and SHA256SUMS
make run ARGS="-addr 127.0.0.1:9000 -data /tmp/sp/bookmarks.json"
```

For manual tests always point `-data` to a temporary directory and use a free port, so the real
data in `~/.local/share/startpage/` and a running instance stay untouched.

## Branches and releases

- `develop` is the working branch. Changes go there directly or through feature branches and pull
  requests.
- `main` holds the released state. It only receives merges from `develop`.
- A release is a tag `vX.Y.Z` on `main`. `.github/workflows/release.yml` checks that the tag is on
  `main`, runs `make check`, builds `make dist` and publishes a GitHub release with the binaries and
  `SHA256SUMS`. Tags with a suffix such as `v1.2.0-rc1` become pre-releases.

```bash
git switch main && git merge --ff-only develop
git tag -a v1.0.0 -m "v1.0.0" && git push origin main v1.0.0
git switch develop
```

`.github/workflows/ci.yml` runs `make check` and `make dist` for pushes to `main` and `develop` and
for pull requests.

## Layout

- `cmd/startpage/`: `main` with flags, logging and server lifecycle. `console_windows.go` and
  `console_other.go` are selected by build tags.
- `internal/server/`: `server.New` builds the handler (API and static files) behind
  `securityMiddleware`; `CheckLoopback` validates the listen address.
- `internal/store/`: data model (`model.go`) with validation; `Store` with a mutex, atomic writes
  (temp file, sync, rename, directory sync), hourly backup rotation and ETag (SHA-256 of the
  content). Files are created with mode 600, directories with 700. An invalid file on disk yields
  `InvalidFileError` and is never overwritten.
- `web/`: `web.Static()` returns the directory `web/static/`, embedded with `//go:embed`. The
  frontend is vanilla JS in `app.js` (sections are listed in its header comment), styles in `style.css`.
- `web/test/`: `app.test.js` (node:test, loads `app.js` without a DOM) and `e2e.mjs` (Chrome DevTools
  Protocol, no packages).
- `init/startpage.service`: template; `make install` replaces `@BINDIR@`.

## API

- `GET /api/health` returns `{"status":"ok"}`.
- `GET /api/bookmarks` returns the data with an `ETag` header.
- `PUT /api/bookmarks` replaces the data. It requires `If-Match` (missing: 428, stale: 412) and
  `X-Requested-With: startpage`. The body is limited to 5 MB; invalid data returns 400.
- An invalid data file on disk makes both endpoints return 500 with the reason in `error`.
- `GET /opensearch.xml` describes the page as a browser search engine, built from the Host header.
- The page reads `?add=<url>&title=<title>` (bookmarklet: prefills the bookmark dialog, saves only
  after OK) and `?q=<terms>` (address bar search: opens the best match directly if every term has a
  substring, tag or host match). Both parameters are removed from the address with `replaceState`.
- Bookmarks carry an optional `description` (max. 2000 characters, line breaks allowed). The search
  matches it below title, tag, host and URL matches, so it never triggers the direct open of `?q=`.
- Bookmarks carry optional `visits` and `lastVisit` (Unix seconds). The search adds a usage bonus
  that is capped below the gap between substring and fuzzy scores.

## Rules

- Go standard library only, no external modules. Frontend without frameworks, CDNs or a build step.
- Keep the security model intact: loopback addresses only, Host header check (DNS rebinding),
  write requests only with `X-Requested-With: startpage` and a matching `Origin`, `If-Match`
  required on `PUT`, strict CSP without inline scripts or inline styles, only `http:` and `https:`
  in URLs.
- Data model changes need validation in `internal/store/model.go` and tests; existing
  `bookmarks.json` files must keep loading.
- Colors only through the CSS variables in `web/static/style.css` (light: Schiefer, dark: Schiefer
  Basalt); no fixed color values in rules. The exception is the favicon fallback tiles
  (`.favicon-fallback`), whose hue is computed from the domain.
- Everything is in English: user interface, messages, documentation, identifiers and comments.
- Cover new logic with tests: Go code with `go test`, pure frontend helpers in `web/test/app.test.js`,
  user-visible behavior in `web/test/e2e.mjs`. Tests run without network access and without fixed ports.
- Commits and pull requests carry no AI attribution (no `Co-Authored-By`, no "Generated with").

## Writing style

These rules apply to every language you write in, and to chat replies, commit messages, code comments, docstrings, READMEs and all other documentation.

Keep your reasoning as thorough as it is now. This constrains phrasing, not thinking.

### Structure

- First sentence is the answer: the result, the verdict, or the change you made. Explanation follows only if it would change what the reader does.
- No preamble. Do not announce what you are about to do before doing it.
- No closing summary that restates the reply.
- No "Would you like me to also...?" at the end.
- When asked to be shorter, remove content. Do not compress the same content into denser phrasing.

### Vocabulary

- Use ordinary, established technical vocabulary. Prefer the common word over the precise-sounding rare one.
- Never invent terminology or aphorisms, and never present a coined term as if it were industry standard.
- Banned words and phrases: load-bearing, hand-waving, the unlock, surface area (unless literally about API surface), first-class, reflexive hedging, honest framing, oracle, constellation, orchestrate (unless it is literally an orchestrator), leverage as a verb, "prose" when "text" is meant, "here's the thing", "the real question is", "here's where I'd push back", "worth noting", "it's important to understand".
- No metaphors invented on the spot. If a metaphor does not already exist in the domain, drop it.

### Sentences

- State what something is. Never open with what it is not. Avoid "It's not X, it's Y" and "This isn't about A, it's about B" entirely.
- Subject, verb, object. One idea per sentence. Split long sentences instead of joining them with dashes.
- Never use – or —. If a dash is unavoidable in running text, use a plain hyphen. Dashes as bullet markers are fine.
- Do not use a dash mid-sentence in place of a comma, colon, semicolon or parentheses.
- No rhetorical questions. No sentence fragments for emphasis. No three-item lists chosen for rhythm rather than content.

### Tone

- Reporting an error: state the error, state the fix, stop. No explanation of why it was a mistake, no assessment of the reader's reasoning, no lecture.
- Missing information: ask one specific question about what is missing. Do not criticise the request or argue against its premise.
- Alternatives: offer them briefly after answering the question that was actually asked, never instead of it.
- If the user is blunt or frustrated, treat it as information about the task. Fix the problem. Do not defend earlier answers and do not mirror the mood.

### Code comments

- A comment describes the current state of the code. It never describes how the code got there. No change history, no "previously we used X", no "replaced the old Y", no record of the decision process. Git holds the history.
- Explain why, not what. If the code already says what it does, write no comment.
- When editing a comment, rewrite it for the new state. The result is usually the same length or shorter than the old one. A comment that grows during an edit is a defect.
- Comments do not include measured performance numbers, dates, ticket numbers or author names unless explicitly asked for.
- Standard length is one line. Two or three lines only for genuinely non-obvious constraints such as a protocol quirk, a race condition or an upstream bug.

#### Comment examples

Bad, because it records history and the decision process:

```python
# We used to call fetch_all() here, but that loaded the entire table into
# memory and caused OOM errors on large tenants. After evaluating several
# options (streaming, pagination, a cursor-based approach), we settled on
# batching with a fixed size of 500, which balances memory usage against
# round-trip overhead. 500 was chosen after benchmarking on staging.
rows = fetch_batched(500)
```

Good, because it states the current constraint only:

```python
# Batched to keep memory flat on large tenants.
rows = fetch_batched(500)
```

Bad, because it restates the code:

```python
# Increment the counter by one
counter += 1
```

Good: no comment.

### READMEs and documentation

- Structure: what it is, how to run it, how to configure it, known limitations. Nothing else unless asked.
- No history sections, no migration narratives, no "background" section explaining how the design was chosen.
- No motivational or marketing language. No claims about the project being clean, robust, elegant, powerful or modern.
- Configuration options go in a table: name, type, default, effect. Not in prose.
- One example per concept. Not three variations of the same example.

#### README example

Bad:

```markdown
### Why we built the cache this way

Caching is a deceptively hard problem. Our first approach used a simple
in-memory dict, which worked well until we started running multiple workers.
At that point, cache coherency became load-bearing for correctness, and we
had to rethink the design from the ground up...
```

Good:

```markdown
### Cache

Redis-backed, shared across workers. TTL is 300s by default, set via
`CACHE_TTL`. Falls back to no caching if Redis is unreachable.
```

### Self-check

Before sending, check the draft for: dashes in running text, sentences that open with a negation, invented terms, a first sentence that is not the answer, and comments that mention how the code used to work. Fix any you find.
