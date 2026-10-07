# Security

## What ISL is, from a security point of view

ISL is a **control plane that executes code**. To do its work it opens git worktrees, runs commands
and test suites, calls a local LLM, starts and restarts containers, writes commits and — if autonomy
is enabled — promotes them. Whoever obtains an authenticated session on ISL is not "reading a
dashboard": in practice they obtain **code execution on the machine hosting it**, with the
permissions of the user who started the process, and write access to the configured repositories.

Keep that in mind while reading everything that follows.

## Do not expose it on a public network

**ISL is designed to run locally, or on a network you trust.** It is not a multi-tenant application
hardened for the Internet, and it must not be put on a public address.

The two things to fix before anything else:

1. **Change `AUTH_SECRET`.** The default value in `.env.example` is `isl-dev-secret-change-me`: it
   is public, it is in this repository, and it is the secret that sessions are signed with. Leaving
   it unchanged on an instance others can reach makes session protection worthless. Generate a long
   random value, and do not reuse it across instances.

2. **Claim the administrator account immediately.** The seeded admin (`ADMIN_EMAIL`, default
   `admin@example.com`) has no password: the **first** sign-in with that email sets the password and
   claims the account. On an instance that is exposed and not yet claimed, the first stranger who
   reaches it becomes the administrator. Do that first sign-in before the server is reachable by
   anyone else.

Beyond that:

- Bind the process to `localhost` and, if you need to reach it from outside, put it behind a reverse
  proxy with TLS and its own authentication, or inside a VPN. Do not open port `7878` to the
  Internet; the WebSocket is gated like the `/api/*` routes, but the same reasoning applies.
- `.data/` holds the platform and project databases: users, sessions, audit trail, backlog, and the
  indexed content and documents of the target projects. It is in `.gitignore`, and it must not be
  published or copied elsewhere without thinking it through.
- The same goes for `.env`: it holds `AUTH_SECRET` and the paths to your repositories.
- Treat target projects as code ISL can modify: point it at a checkout you can inspect and restore,
  not at the only copy of something.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use the repository's private channel — **GitHub Security Advisories**:

👉 [Report a vulnerability privately](https://github.com/mrbot0/ISL---improvment-software-loop/security/advisories/new)

(From the repository: **Security** tab → **Report a vulnerability**.) The report stays visible only
to you and to the people maintaining the project, until an advisory is published.

There is no dedicated email address: the channel above is the only private route for reports.

A report is more useful if it includes:

- the version or commit of ISL;
- which component is involved (auth and sessions, `/api/*` routes, WebSocket, sandbox and
  worktrees, container runtime, dashboard, knowledge index…);
- the steps to reproduce, and the impact that follows from them;
- whether you needed an authenticated session, and with which role (`admin`, `user`, `viewer`).

What we can say about timing, without promising what we cannot keep: ISL is maintained in spare
time, there is no on-call rotation, and **there are no guaranteed response times**. Reports are read
and, as far as possible, addressed in order of severity. There is no bug bounty program and there
are no rewards.

### Disclosure

We prefer coordinated disclosure: report privately, and we agree on when to publish. If you would
rather publish on your own, that is your choice — we only ask that you tell us, so that the people
using ISL can be warned at the same time as the publication. Credit for the discovery is
acknowledged in the advisory, if you want it.

## Covered versions

The project has a single active line of development: **the latest commit on the default branch**.
There are no maintenance branches and no backports to earlier versions. A security fix lands there.

## What is not a vulnerability

Some behaviours are by design, and reporting them as flaws will not lead to a fix:

- **The agents execute code.** The iteration engine runs the target project's builds, tests and
  commands inside a sandbox: that is its job, not an escalation.
- **An administrator can make ISL execute code.** The `admin` role configures the projects and the
  runtime; by definition it has the power described at the top of this page.
- **The instance is not hardened for public exposure.** A problem whose premise is that ISL was put
  on a public network against what is written here is documented — it is not a new report.

What does remain useful and welcome, for example: bypassing authentication or the WebSocket gate,
escalating role (a `viewer` or `user` obtaining `admin` capabilities), escaping the sandbox toward
paths the active project does not cover, reading one project's data from a session that has no
access to it, getting commands executed through content ISL only *reads* (documents, diffs, model
output), or a secret that ends up in the logs, in API responses or in a commit.
