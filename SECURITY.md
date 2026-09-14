# Security

OPNinfer holds an organisation's provider API keys, every conversation its
people have with the assistant, and every file they upload. A break here is not
an inconvenience, so please report problems privately and we will treat them
that way.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** — the *Security* tab on this
repository, then *Report a vulnerability*. That opens a private thread visible
only to the maintainers, and it needs no email address from you.

Please do not open a public issue, a pull request, or a discussion for
anything you think might be exploitable. If you are unsure whether something
qualifies, report it privately anyway; over-reporting costs an afternoon,
under-reporting costs somebody their data.

Useful things to include, roughly in order of value: what an attacker ends up
able to do, the smallest set of steps that shows it, which version or commit
you tested, and whether it needs an account (and if so, what kind — a normal
user, an admin, or someone who has been removed from a shared chat).

You will get an acknowledgement that a human has read it. Please give us a
reasonable window to ship a fix before saying anything publicly; we will credit
you when it goes out, unless you'd rather we didn't.

## What is in scope

Anything in this repository, and in particular the places where a boundary is
supposed to hold:

- **Authentication and sessions** — sign-in, invites, password reset,
  temporary passwords, the admin role gate, sudo mode for reading a user's
  chats.
- **Access to someone else's data** — another person's chats, files, memory or
  usage; anything reachable after being removed from a shared chat.
- **Provider credentials** — anything that could read an API key out of the
  encrypted store, or route one somewhere it shouldn't go. The Sandbox's
  credential proxy exists specifically so that an organisation's key never
  enters a container; holes in that are especially interesting.
- **The Sandbox container boundary** — escaping the per-chat container,
  reaching the Docker socket, reading another chat's workspace or agent state.
- **Path handling in the storage pools** — the containment guard resolves real
  paths rather than doing string arithmetic, precisely because code the model
  runs shares that directory. Anything that gets out of a pool matters.
- **Server-side request forgery** in the web tools and `download_file`.
- **Injection** of any kind, including prompt injection that crosses a
  security boundary rather than merely producing a bad answer.

## What is out of scope

- Findings from an automated scanner with no working exploit behind them.
- Missing hardening headers, cookie flags or TLS configuration on a deployment
  you do not control — TLS and the reverse proxy are the operator's
  responsibility (see *Deployment* in `CLAUDE.md`).
- Anything that requires an attacker to already hold the master key, the
  database, or a shell on the host. Those are game over by design, which is why
  `OPNINFER_MASTER_KEY` is documented as the thing to back up and protect.
- The model saying something wrong, biased or embarrassing. That matters, but
  it is a bug report, not a vulnerability.
- Denial of service by simply sending a lot of traffic.

## What this project does not promise

There is no bug bounty. Only the latest release gets fixes; there are no
long-term support branches. OPNinfer is designed to be run **behind your own
reverse proxy on infrastructure you control**, not exposed naked to the
internet, and it assumes the people with accounts on an instance are members of
the organisation that runs it — there is no public sign-up by design.
