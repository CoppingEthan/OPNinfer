/**
 * Structured user questions (`ask_user`) — the pure core.
 *
 * When a request has a genuine fork in it that the assistant cannot infer its
 * way past ("which of these three files?", "PDF or Word?"), guessing wastes a
 * whole turn and asking in prose costs a full round-trip the user has to read.
 * Instead the assistant emits a short multiple-choice card, and its reply
 * PAUSES mid-flow until the answer arrives — then continues in the same turn
 * with the answer in hand.
 *
 * This module is deliberately pure (no imports, no server-only): the model's
 * arguments are normalised and validated here, the answers are formatted for
 * the model here, and the same types drive the card in the browser. The
 * waiting half — the mailbox a running turn parks on — lives in
 * `ask-mailbox.ts` (server), the way `tool-run.ts` is pure and the pipeline
 * that consumes it is not.
 */

/** Ceilings mirrored in the tool schema. Four questions is plenty for one
 *  pause, and more than four options stops reading as a quick choice. */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** The chip above each question — a couple of words, not a sentence. */
export const MAX_HEADER_CHARS = 20;
export const MAX_QUESTION_CHARS = 300;
export const MAX_OPTION_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 400;
/** Cap on a typed "something else" / direct reply. */
export const MAX_CUSTOM_CHARS = 2_000;

export interface AskOption {
  label: string;
  /** Optional one-liner under the label — trade-offs, what it implies. */
  description?: string;
}

export interface AskQuestion {
  /** Short chip label, e.g. "Format", "Approach". */
  header: string;
  question: string;
  options: AskOption[];
  /** Several answers may be picked at once. */
  multiSelect?: boolean;
}

export interface AskAnswer {
  header: string;
  question: string;
  /** Chosen option labels, or the single free-text answer. Empty when skipped. */
  chosen: string[];
  /** The user typed this instead of picking an offered option. */
  custom?: boolean;
  /** The user declined to answer this one. */
  skipped?: boolean;
}

/**
 * `pending` — card is up, the turn is parked.
 * `answered` — the user submitted (individual questions may still be skipped).
 * `dismissed` — the turn was stopped, or it ended before an answer arrived.
 * `expired` — nobody answered within the wait window.
 */
export type AskStatus = "pending" | "answered" | "dismissed" | "expired";

/** One ask as persisted on the reply (`meta.asks`) — so the question, its
 *  options and which one was chosen all survive a reload, the same way
 *  `meta.toolRuns` keeps the collapsed run chips. */
/** Who settled a question card — shown as "Answered by …" in a shared chat. */
export interface AskBy {
  id: string;
  name: string;
}

export interface AskRecord {
  id: string;
  questions: AskQuestion[];
  answers?: AskAnswer[];
  status: AskStatus;
  answeredBy?: AskBy;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Derive a chip from the question when the model omitted one. */
function deriveHeader(question: string): string {
  const words = question.replace(/[?.!]+$/, "").split(" ").filter(Boolean);
  const head = words.slice(0, 3).join(" ");
  return (head || "Question").slice(0, MAX_HEADER_CHARS);
}

/** Accept an option as either a bare string or `{label, description}` — models
 *  produce both regardless of the schema, and refusing the simpler shape would
 *  burn a tool round on a formatting technicality. */
function normaliseOption(raw: unknown): AskOption | null {
  if (typeof raw === "string") {
    const label = clean(raw, MAX_OPTION_CHARS);
    return label ? { label } : null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as { label?: unknown; description?: unknown; value?: unknown; text?: unknown };
    const label = clean(o.label ?? o.value ?? o.text, MAX_OPTION_CHARS);
    if (!label) return null;
    const description = clean(o.description, MAX_DESCRIPTION_CHARS);
    return description ? { label, description } : { label };
  }
  return null;
}

/**
 * Normalise + validate the model's `questions` argument.
 *
 * Returns cleaned questions, or an `error` written FOR THE MODEL: it is about
 * to be handed straight back as the tool result, so it has to say exactly what
 * to fix rather than just that something was wrong.
 */
export function parseAskQuestions(
  raw: unknown,
): { questions: AskQuestion[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0) {
    return { error: "`questions` must be a non-empty array of question objects." };
  }
  if (list.length > MAX_QUESTIONS) {
    return {
      error: `Too many questions (${list.length}). Ask at most ${MAX_QUESTIONS} in one call — pick the ones whose answers actually change what you produce.`,
    };
  }

  const questions: AskQuestion[] = [];
  for (const [i, entry] of list.entries()) {
    const at = `question ${i + 1}`;
    if (!entry || typeof entry !== "object") {
      return { error: `${at} is not an object. Each entry needs { question, options }.` };
    }
    const e = entry as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    const question = clean(e.question, MAX_QUESTION_CHARS);
    if (!question) return { error: `${at} is missing a \`question\` string.` };

    const rawOptions = Array.isArray(e.options) ? e.options : [];
    const options: AskOption[] = [];
    const seen = new Set<string>();
    for (const opt of rawOptions) {
      const norm = normaliseOption(opt);
      // Duplicate labels make the card ambiguous and the answer meaningless.
      if (norm && !seen.has(norm.label.toLowerCase())) {
        seen.add(norm.label.toLowerCase());
        options.push(norm);
      }
      if (options.length === MAX_OPTIONS) break;
    }
    if (options.length < MIN_OPTIONS) {
      return {
        error: `${at} needs at least ${MIN_OPTIONS} distinct options (got ${options.length}). If there is only one sensible answer, don't ask — just proceed with it.`,
      };
    }

    questions.push({
      header: clean(e.header, MAX_HEADER_CHARS) || deriveHeader(question),
      question,
      options,
      ...(e.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return { questions };
}

/** Normalise one submitted answer against the question it answers, so a
 *  hand-rolled or stale client can't put labels in that were never offered
 *  (free text is fine, but it's recorded as free text, not as a choice). */
export function normaliseAnswer(
  question: AskQuestion,
  submitted: { chosen?: unknown; custom?: unknown; skipped?: unknown },
): AskAnswer {
  const base = { header: question.header, question: question.question };
  if (submitted.skipped === true) return { ...base, chosen: [], skipped: true };

  const offered = new Map(question.options.map((o) => [o.label.toLowerCase(), o.label]));
  const raw = Array.isArray(submitted.chosen)
    ? submitted.chosen
    : typeof submitted.chosen === "string"
      ? [submitted.chosen]
      : [];

  const picked: string[] = [];
  const typed: string[] = [];
  for (const value of raw) {
    const text = clean(value, MAX_CUSTOM_CHARS);
    if (!text) continue;
    const match = offered.get(text.toLowerCase());
    if (match) {
      if (!picked.includes(match)) picked.push(match);
    } else if (!typed.includes(text)) {
      typed.push(text);
    }
  }

  // A typed answer stands on its own — it's the user overriding the menu, so
  // don't dilute it with whatever was also ticked.
  if (typed.length > 0) {
    return { ...base, chosen: [typed.join("; ").slice(0, MAX_CUSTOM_CHARS)], custom: true };
  }
  if (picked.length === 0) return { ...base, chosen: [], skipped: true };
  return { ...base, chosen: question.multiSelect ? picked : [picked[0]] };
}

/** Human one-liner for the UI (and the persisted user message). */
export function summariseAnswer(answer: AskAnswer): string {
  if (answer.skipped || answer.chosen.length === 0) return "No preference";
  return answer.chosen.join(", ");
}

/** The user's answers as ONE chat message — the visible record of what they
 *  chose (and what later turns replay, since only user/assistant rows are fed
 *  back to the model). Single-question asks read as a plain reply; multi
 *  question asks are labelled so the pairing survives. */
export function answersAsUserMessage(answers: AskAnswer[]): string {
  const meaningful = answers.filter((a) => !a.skipped && a.chosen.length > 0);
  if (meaningful.length === 0) return "(no preference — your call)";
  if (answers.length === 1) return summariseAnswer(answers[0]);
  return meaningful.map((a) => `${a.header}: ${summariseAnswer(a)}`).join(" · ");
}

/** The tool result: the question/answer pairs the model reads back before
 *  carrying on. Skips are stated explicitly — silence would read as an
 *  answered question and the model would invent one. */
export function formatAskResult(answers: AskAnswer[]): string {
  const lines = answers.map((a, i) => {
    const n = answers.length > 1 ? `${i + 1}. ` : "";
    if (a.skipped || a.chosen.length === 0) {
      return `${n}${a.question} → (skipped — the user gave no preference; choose a sensible default and say which you chose)`;
    }
    const suffix = a.custom ? " (typed by the user, not one of your options)" : "";
    return `${n}${a.question} → ${a.chosen.join(", ")}${suffix}`;
  });
  return `The user answered:\n${lines.join("\n")}\n\nContinue the task now using these answers. Do not ask again.`;
}

/** Result text when no answer is coming (turn stopped, or the wait ran out). */
export function formatAskUnanswered(status: "dismissed" | "expired"): string {
  const why =
    status === "expired"
      ? "The user did not answer in time"
      : "The user dismissed the question without answering";
  return (
    `${why}. Do not ask again. Proceed with the most reasonable default, ` +
    `state plainly which one you picked, and keep going.`
  );
}
