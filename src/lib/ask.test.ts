import { describe, expect, it } from "vitest";
import {
  MAX_QUESTIONS,
  answersAsUserMessage,
  formatAskResult,
  formatAskUnanswered,
  normaliseAnswer,
  parseAskQuestions,
  summariseAnswer,
} from "./ask";
import type { AskQuestion } from "./ask";

const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  header: "City",
  question: "Which city?",
  options: [{ label: "Manchester" }, { label: "Bristol" }],
  ...over,
});

describe("parseAskQuestions", () => {
  it("accepts a well-formed question", () => {
    const out = parseAskQuestions([
      { header: "Format", question: "Which format?", options: [{ label: "PDF" }, { label: "Word" }] },
    ]);
    expect(out).toEqual({
      questions: [
        { header: "Format", question: "Which format?", options: [{ label: "PDF" }, { label: "Word" }] },
      ],
    });
  });

  it("accepts bare-string options — models produce them regardless of schema", () => {
    const out = parseAskQuestions([{ question: "Which city?", options: ["Manchester", "Bristol"] }]);
    expect("questions" in out && out.questions[0].options).toEqual([
      { label: "Manchester" },
      { label: "Bristol" },
    ]);
  });

  it("derives a header when the model omits one", () => {
    const out = parseAskQuestions([{ question: "Which output format do you want?", options: ["a", "b"] }]);
    expect("questions" in out && out.questions[0].header).toBe("Which output format");
  });

  it("drops duplicate option labels, then rejects for having too few", () => {
    const out = parseAskQuestions([{ question: "Which?", options: ["PDF", "pdf", "PDF"] }]);
    expect("error" in out && out.error).toMatch(/at least 2 distinct options/);
  });

  it("rejects a single-option question and says why", () => {
    const out = parseAskQuestions([{ question: "Which?", options: ["Only one"] }]);
    expect("error" in out && out.error).toMatch(/don't ask/);
  });

  it("rejects more than the question ceiling", () => {
    const many = Array.from({ length: MAX_QUESTIONS + 1 }, () => ({
      question: "Which?",
      options: ["a", "b"],
    }));
    expect("error" in parseAskQuestions(many)).toBe(true);
  });

  it("rejects an empty or non-array argument", () => {
    expect("error" in parseAskQuestions([])).toBe(true);
    expect("error" in parseAskQuestions(undefined)).toBe(true);
    expect("error" in parseAskQuestions("Which city?")).toBe(true);
  });

  it("caps options at the ceiling rather than failing", () => {
    const out = parseAskQuestions([{ question: "Which?", options: ["a", "b", "c", "d", "e", "f"] }]);
    expect("questions" in out && out.questions[0].options).toHaveLength(4);
  });

  it("keeps multiSelect only when explicitly true", () => {
    const on = parseAskQuestions([{ question: "Which?", options: ["a", "b"], multiSelect: true }]);
    const off = parseAskQuestions([{ question: "Which?", options: ["a", "b"], multiSelect: "yes" }]);
    expect("questions" in on && on.questions[0].multiSelect).toBe(true);
    expect("questions" in off && off.questions[0].multiSelect).toBeUndefined();
  });
});

describe("normaliseAnswer", () => {
  it("keeps a single offered label", () => {
    expect(normaliseAnswer(q(), { chosen: ["Bristol"] })).toEqual({
      header: "City",
      question: "Which city?",
      chosen: ["Bristol"],
    });
  });

  it("matches an offered label case-insensitively and restores its casing", () => {
    expect(normaliseAnswer(q(), { chosen: ["manchester"] }).chosen).toEqual(["Manchester"]);
  });

  it("records an unoffered value as free text, not as a choice", () => {
    const a = normaliseAnswer(q(), { chosen: ["Leeds"] });
    expect(a.chosen).toEqual(["Leeds"]);
    expect(a.custom).toBe(true);
  });

  it("ignores extra picks on a single-select question", () => {
    expect(normaliseAnswer(q(), { chosen: ["Manchester", "Bristol"] }).chosen).toEqual(["Manchester"]);
  });

  it("keeps every pick on a multiSelect question", () => {
    const a = normaliseAnswer(q({ multiSelect: true }), { chosen: ["Manchester", "Bristol"] });
    expect(a.chosen).toEqual(["Manchester", "Bristol"]);
  });

  it("lets free text win outright over whatever was also ticked", () => {
    const a = normaliseAnswer(q({ multiSelect: true }), { chosen: ["Manchester", "Somewhere else"] });
    expect(a.custom).toBe(true);
    expect(a.chosen).toEqual(["Somewhere else"]);
  });

  it("treats an explicit skip, an empty pick and blank text alike", () => {
    expect(normaliseAnswer(q(), { skipped: true }).skipped).toBe(true);
    expect(normaliseAnswer(q(), { chosen: [] }).skipped).toBe(true);
    expect(normaliseAnswer(q(), { chosen: ["   "] }).skipped).toBe(true);
  });
});

describe("formatAskResult", () => {
  it("pairs each question with its answer", () => {
    const text = formatAskResult([
      { header: "City", question: "Which city?", chosen: ["Bristol"] },
      { header: "Budget", question: "What budget?", chosen: ["£150"], custom: true },
    ]);
    expect(text).toContain("1. Which city? → Bristol");
    expect(text).toContain("2. What budget? → £150 (typed by the user, not one of your options)");
    expect(text).toContain("Do not ask again");
  });

  it("states a skip explicitly — silence would read as an answer", () => {
    const text = formatAskResult([{ header: "City", question: "Which city?", chosen: [], skipped: true }]);
    expect(text).toMatch(/skipped/);
    expect(text).toMatch(/sensible default/);
  });

  it("tells the model to proceed when nothing is coming", () => {
    expect(formatAskUnanswered("expired")).toMatch(/did not answer in time/);
    expect(formatAskUnanswered("dismissed")).toMatch(/dismissed/);
    for (const s of ["expired", "dismissed"] as const) {
      expect(formatAskUnanswered(s)).toMatch(/Do not ask again/);
    }
  });
});

describe("answersAsUserMessage", () => {
  it("reads as a plain reply for one question", () => {
    expect(answersAsUserMessage([{ header: "City", question: "Which city?", chosen: ["Bristol"] }])).toBe(
      "Bristol",
    );
  });

  it("labels each answer when several were asked", () => {
    expect(
      answersAsUserMessage([
        { header: "City", question: "Which city?", chosen: ["Bristol"] },
        { header: "Budget", question: "What budget?", chosen: ["£150"] },
      ]),
    ).toBe("City: Bristol · Budget: £150");
  });

  it("omits skipped questions from the visible message", () => {
    expect(
      answersAsUserMessage([
        { header: "City", question: "Which city?", chosen: ["Bristol"] },
        { header: "Budget", question: "What budget?", chosen: [], skipped: true },
      ]),
    ).toBe("City: Bristol");
  });

  it("never produces an empty message when everything was skipped", () => {
    const text = answersAsUserMessage([
      { header: "City", question: "Which city?", chosen: [], skipped: true },
    ]);
    expect(text.length).toBeGreaterThan(0);
    expect(summariseAnswer({ header: "City", question: "Which city?", chosen: [] })).toBe(
      "No preference",
    );
  });
});
