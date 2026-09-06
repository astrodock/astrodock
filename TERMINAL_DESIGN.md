# The per-app terminal

A design note. Nothing here is built yet.

## The thing to know first

**This decision is already locked, and the code went the other way.**

`DECISIONS.md` A6 says the `/exec` SSE terminal is "ported but registered only
when `ASTRODOCK_ENABLE_TERMINAL=true`". `SECURITY.md` documents it as
arbitrary-RCE-by-design. `BUILD_PLAN.md` repeats it.

None of that shipped. `ASTRODOCK_ENABLE_TERMINAL` appears in four documents and
zero lines of code. What actually happened is in the header of
`apps/control-plane/src/runner/app-ops.js`:

> Structured operations on a deployed app, what the terminal was actually used
> for, offered as named actions instead of a shell.

So the terminal was replaced rather than ported, for a stated reason, and the
docs were never updated. Either the code or the decision needs to move. That is
the first thing to settle.

## What the precursor does

`SV - Sandbox/auth-api/src/routes/admin-apps.js:524`

| | |
|---|---|
| Shape | `GET /:slug/exec?command=…`, Server-Sent Events |
| Execution | `spawn('sh', ['-c', command])`, cwd is the app directory |
| Environment | `PATH`, `HOME`, `NODE_ENV`, plus the app's own vars. Deliberately not the platform's |
| Limits | 5 minute timeout; `SIGTERM` when the client disconnects |
| Streaming | `stdout`, `stderr`, `exit`, `error` as separate SSE event types |

It is not a PTY. It runs a command and streams the output. No `vim`, no `top`,
no interactive prompts.

The shape is good. Restricting the environment to the app's own vars was the
right instinct and predates anyone writing it down.

## Why it was not ported as-is

Two flaws, both about *where* it ran rather than what it did:

1. **It ran in the API container**, which loads the whole `.env`: the key that
   decrypts every app's secrets, the admin JWT signing secret, the runner
   token, the database password. One `sh -c` reached all of it.
2. **It could not do its job.** App files live on the runner, which the API does
   not mount. So it was able to compromise everything while being unable to
   `ls` the directory it was pointed at.

Astrodock removes both by construction. The runner already holds the app files,
already runs commands as the app's own user (`runAsApp` in `deploy-worker.js`),
and already computes a per-app environment (`computeEnv`) that is exactly what
PM2 gets. The dangerous half of the precursor was its address, not its design.

## The other half of the argument

`app-ops.js` draws a distinction worth keeping:

> COMMITTED commands (declared in `app.json`) are code a human reviewed and
> committed. COMPOSED commands (a string assembled from log output) are not, and
> an agent debugging an app is reading build logs, runtime logs, HTTP access
> logs and repository contents, all of which an attacker can influence.

That is a real threat model, not caution for its own sake. An agent that reads a
log line and runs what it suggests is a confused deputy with root on the box.

It argues for the terminal being a *human* tool, gated separately from the token
permissions an agent holds. It does not argue against the terminal existing:
last night an app crash-looped 809 times and the only way to find out why was to
make the app write a diagnostic file into its own directory and read it back
through the file browser.

## Proposed shape

```
POST /apps/:slug/exec        (runner, SSE)
```

| Decision | Proposal | Because |
|---|---|---|
| Where | Runner, not control plane | The files are there; the platform's secrets are not |
| Gate | `ASTRODOCK_ENABLE_TERMINAL`, default off | Already the locked decision |
| User | The app's own user, via `runAsApp` | Same blast radius as the app itself |
| cwd | `/data/apps/<slug>` | What you came to look at |
| Environment | `computeEnv(app, envVars)` | Identical to what the process sees. No platform vars |
| Timeout | 5 minutes, `SIGTERM` on disconnect | Ported unchanged |
| Audit | One event per invocation, with the command text | A shell nobody can review is worse than no shell |
| Permission | New `runtime:exec`, not `runtime:write` | A deploy token should not open a shell |

`runDeclared` stays as the everyday path. The terminal is the escape hatch for
when a named action does not exist yet, and the honest test of whether it is
needed is how often someone reaches for it.

## Decisions to make

| | Question | Options | Recommendation |
|---|---|---|---|
| T1 | Reconcile the contradiction | Implement the terminal, or amend `DECISIONS.md` A6 to say it was replaced | **Implement**, since the need is now demonstrated |
| T2 | Command-and-stream, or a real PTY | Port SV's SSE shape / `node-pty` + `xterm.js` | **SSE first.** A PTY adds a native dependency and interactive-session lifecycle for `vim`, which is not what the outage needed |
| T3 | Permission | Reuse `runtime:write` / add `runtime:exec` | **Add one.** Restart and deploy are not the same trust as a shell |
| T4 | Secrets in output | Pass through / mask with the same pass as `ops/file` | **Mask.** `env` in a terminal whose output lands in an audit log is how a key ends up in a database |
| T5 | Who may use it | Any admin / operator role only | Open. Depends on whether admin is already a single trusted operator |

## What is already fixed

These came out of the same incident and are done, so the terminal does not need
to carry them:

- PM2 logs read from `PM2_HOME`, so the Logs tab works for every app.
- A deploy fails when the process it started is not running.
- Restart and stop are recorded, and the UI says what happened.
- Secrets are masked out of files served by the ops browser.
- `scripts` is a valid manifest key, so `runDeclared` is reachable at all.
