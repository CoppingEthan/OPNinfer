import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * No component may use the browser's own confirm/prompt/alert.
 *
 * They are unstyled, ignore the theme, block the tab, put "localhost:3000
 * says" above your careful wording, and on a phone read as though the SITE is
 * broken rather than as the app asking a question. `useDialog()` replaces all
 * three.
 *
 * This is a SOURCE test because the failure has no symptom anyone would go
 * looking for: a stray `confirm()` works perfectly, it just looks like a
 * different, worse application for one moment.
 */

const ROOT = path.join(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx$/.test(entry) && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/** `confirm(` etc. preceded by anything other than a dot or a word character,
 *  so `dialog.confirm(` and `onConfirm(` do not match. */
const NATIVE = /(^|[^.\w])(confirm|prompt|alert)\s*\(/;

describe("the browser's own dialogs", () => {
  it("are used nowhere in the app", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      // The fallback inside the dialog itself is the one allowed use: without
      // a provider a delete button must still work rather than do nothing.
      if (file.endsWith(path.join("ui", "dialog.tsx"))) continue;
      const src = readFileSync(file, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (NATIVE.test(line)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(
      offenders,
      `Use useDialog() from @/components/ui/dialog instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("…and the replacement is actually mounted app-wide", () => {
    // A provider nobody renders would make every call silently fall back to
    // the browser dialogs this test exists to forbid.
    const providers = readFileSync(path.join(ROOT, "app", "providers.tsx"), "utf8");
    expect(providers).toContain("DialogProvider");
  });
});
