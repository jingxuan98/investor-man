import { expect, test } from "vitest";
import { normalizeMarkdownTables } from "@/lib/markdownTables";

test("inserts a missing delimiter row after a header row", () => {
  const input = ["| Scenario | Price |", "| Bear | 3.82 |", "| Bull | 7.91 |"].join("\n");
  const out = normalizeMarkdownTables(input);
  const lines = out.split("\n");
  expect(lines[0]).toBe("| Scenario | Price |");
  expect(lines[1]).toBe("| --- | --- |");
  expect(lines[2]).toBe("| Bear | 3.82 |");
  expect(lines[3]).toBe("| Bull | 7.91 |");
});

test("leaves a well-formed table completely untouched", () => {
  const input = [
    "## Scenario Analysis",
    "",
    "| Scenario | Probability | Target |",
    "| :--- | :--- | :--- |",
    "| Bear | 30% | 3.82 |",
    "| Base | 50% | 4.36 |",
    "",
    "Some trailing prose.",
  ].join("\n");
  expect(normalizeMarkdownTables(input)).toBe(input);
});

test("leaves non-table pipes alone", () => {
  const input = [
    "Use the `a | b` syntax in your shell config.",
    "",
    "A lone row with pipes but no continuation: | just one line |",
    "",
    "More prose after.",
  ].join("\n");
  expect(normalizeMarkdownTables(input)).toBe(input);
});

test("does not touch pipe-like content inside a fenced code block", () => {
  const input = ["```", "| a | b |", "| c | d |", "```"].join("\n");
  expect(normalizeMarkdownTables(input)).toBe(input);
});

test("handles a header with a differing column count by inferring from the header row", () => {
  const input = ["| A | B | C |", "| 1 | 2 | 3 |"].join("\n");
  const out = normalizeMarkdownTables(input);
  expect(out.split("\n")[1]).toBe("| --- | --- | --- |");
});

test("never throws on empty or garbage input", () => {
  expect(normalizeMarkdownTables("")).toBe("");
  expect(() => normalizeMarkdownTables("||||\n|\n")).not.toThrow();
});
