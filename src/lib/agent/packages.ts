/**
 * What the Sandbox agent reaches for at runtime — pure parsing (owner ask,
 * 2026-09-02).
 *
 * Every shell command the agent runs passes through here. Installs (pip, npm,
 * apt, gem, cargo, go) and external fetches (curl/wget/git clone) are
 * extracted so Admin → Tools can show the TOP ones against what the image
 * already has: a data-driven answer to "what should we bake in next?".
 *
 * Deliberately loose: this is a tally, not a security boundary. A command
 * that fools it merely goes uncounted.
 */

export type PackageKind = "pip" | "npm" | "apt" | "gem" | "cargo" | "go" | "download" | "git";

export interface PackageUse {
  kind: PackageKind;
  /** Package name (normalised) — or the host for a download, host/path for a clone. */
  name: string;
}

/** Split a shell line into simple commands on the usual separators. */
function segments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokens(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  // Drop leading env assignments and wrappers.
  while (out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || /^(sudo|nohup|time|exec|env)$/.test(out[0]))) out.shift();
  // Drop shell redirections — attached (`2>&1`, `>log`, `2>/dev/null`) and
  // detached (`> log`, `2> /dev/null`, `< in`), where the operator's TARGET
  // is the next token: "2>&1" once survived the version-spec strip as a
  // package called "2", and "> install.log" as "install-log".
  const clean: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (/^(\d*[<>]{1,2}|&>)$/.test(t)) {
      i++; // operator alone: its target follows
      continue;
    }
    if (/^(\d*[<>]{1,2}|&>)/.test(t)) continue; // operator with target attached
    clean.push(t);
  }
  return clean;
}

/** PEP 503 name normalisation. */
export function normalisePythonName(spec: string): string | null {
  let s = spec.trim();
  if (!s || s.startsWith("-")) return null;
  if (/^(git\+|https?:|file:|\.|\/|~)/.test(s) || /\.(whl|tar\.gz|zip)$/.test(s)) return null;
  s = s.replace(/\[.*$/, ""); // extras
  s = s.replace(/\s*@.*$/, ""); // "name @ url"
  s = s.replace(/[=<>!~].*$/, ""); // version specifiers
  s = s.replace(/[-_.]+/g, "-").toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(s) ? s : null;
}

/** npm spec → package name (scoped names keep their scope, lose the version). */
export function normaliseNpmName(spec: string): string | null {
  const s = spec.trim();
  if (!s || s.startsWith("-")) return null;
  if (/^(https?:|git\+|github:|file:|\.|\/|~)/.test(s) || /\.(tgz|tar\.gz)$/.test(s)) return null;
  const m = s.match(/^(@[^/@]+\/[^@]+|[^@]+)/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "host.docker.internal" || /^127\./.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
    return h;
  } catch {
    return null;
  }
}

/** Options that consume the following token (so it is not read as a package). */
const PIP_VALUE_FLAGS = new Set(["-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target", "-e", "--editable", "--python", "--prefix", "--root"]);
const NPM_VALUE_FLAGS = new Set(["--prefix", "--registry", "-C", "--tag", "--workspace", "-w"]);

function positional(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (valueFlags.has(a) && !a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function extractPackageUses(command: string): PackageUse[] {
  const found: PackageUse[] = [];
  const add = (kind: PackageKind, name: string | null) => {
    if (name && !found.some((f) => f.kind === kind && f.name === name)) found.push({ kind, name });
  };

  for (const seg of segments(command)) {
    const t = tokens(seg);
    if (t.length === 0) continue;
    const [cmd, ...rest] = t;
    const base = cmd.replace(/^.*\//, "");

    // --- pip family ---------------------------------------------------------
    let pipArgs: string[] | null = null;
    if (/^pip[0-9.]*$/.test(base) && rest[0] === "install") pipArgs = rest.slice(1);
    else if (/^python[0-9.]*$/.test(base) && rest[0] === "-m" && /^pip[0-9.]*$/.test(rest[1] ?? "") && rest[2] === "install") pipArgs = rest.slice(3);
    else if (base === "uv" && rest[0] === "pip" && rest[1] === "install") pipArgs = rest.slice(2);
    else if (base === "uv" && rest[0] === "add") pipArgs = rest.slice(1);
    else if (base === "pipx" && rest[0] === "install") pipArgs = rest.slice(1);
    else if (base === "poetry" && rest[0] === "add") pipArgs = rest.slice(1);
    else if (base === "conda" && rest[0] === "install") pipArgs = rest.slice(1).filter((a) => a !== "-y");
    if (pipArgs) {
      for (const spec of positional(pipArgs, PIP_VALUE_FLAGS)) add("pip", normalisePythonName(spec));
      continue;
    }

    // --- npm family ---------------------------------------------------------
    let npmArgs: string[] | null = null;
    if (base === "npm" && /^(install|i|add)$/.test(rest[0] ?? "")) npmArgs = rest.slice(1);
    else if (base === "npx" && rest.length) npmArgs = [rest.find((a) => !a.startsWith("-")) ?? ""];
    else if (base === "pnpm" && /^(add|install|i)$/.test(rest[0] ?? "")) npmArgs = rest.slice(1);
    else if (base === "yarn" && rest[0] === "add") npmArgs = rest.slice(1);
    else if (base === "bun" && /^(add|install|i)$/.test(rest[0] ?? "")) npmArgs = rest.slice(1);
    if (npmArgs) {
      // A bare `npm install` restores package.json — not a package choice.
      for (const spec of positional(npmArgs, NPM_VALUE_FLAGS)) add("npm", normaliseNpmName(spec));
      continue;
    }

    // --- apt (will fail without root, but the INTENT is the data) -----------
    if ((base === "apt-get" || base === "apt") && rest.includes("install")) {
      const after = rest.slice(rest.indexOf("install") + 1);
      for (const p of positional(after, new Set(["-o", "-t"]))) if (/^[a-z0-9][a-z0-9+.-]*$/.test(p)) add("apt", p);
      continue;
    }

    // --- other language package managers -------------------------------------
    if (base === "gem" && rest[0] === "install") {
      for (const p of positional(rest.slice(1), new Set(["-v", "--version"]))) add("gem", p.toLowerCase());
      continue;
    }
    if (base === "cargo" && rest[0] === "install") {
      for (const p of positional(rest.slice(1), new Set(["--version", "--git", "--path", "--root"]))) add("cargo", p.toLowerCase());
      continue;
    }
    if (base === "go" && rest[0] === "install") {
      for (const p of positional(rest.slice(1), new Set())) add("go", p.replace(/@.*$/, "").toLowerCase());
      continue;
    }

    // --- external fetches -----------------------------------------------------
    if (base === "git" && rest[0] === "clone") {
      const url = rest.slice(1).find((a) => /^(https?:|git@|ssh:|git:)/.test(a));
      if (url) {
        const m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/(?:git@)?|git:\/\/)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
        if (m) add("git", `${m[1].toLowerCase()}/${m[2]}`);
      }
      continue;
    }
    if (base === "curl" || base === "wget" || base === "aria2c") {
      for (const a of rest) if (/^https?:\/\//i.test(a)) add("download", hostOf(a));
      continue;
    }
  }
  return found;
}
