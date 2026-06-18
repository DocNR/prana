import { NostrEvent } from "./types";

/**
 * Complexity inference: tag an issue S / M / L so a contributor can pick work
 * that fits the capacity they have.
 *
 * WHY NOT LABELS: per finding #3 (CLAUDE.md), real `t` labels are sparse and
 * inconsistent (`compati`/`compatability`/`compatibility`, mostly unlabeled) —
 * you cannot derive complexity from them. The intended production path is LLM
 * triage over issue text + linked-diff size. That needs an API key and is
 * non-deterministic, so it lives behind the `ComplexityScorer` interface.
 *
 * This module ships a pure, deterministic HEURISTIC scorer as the default so the
 * worklist runs offline and is testable. Swap in an LLM scorer (same interface)
 * where a key is available — the worklist doesn't care which it gets.
 */

export type Complexity = "S" | "M" | "L";

export interface ComplexitySignal {
  complexity: Complexity;
  score: number; // raw heuristic score, surfaced for transparency
  reasons: string[]; // human-readable "why", so a UI/demo can explain the tag
}

export interface ComplexityScorer {
  score(issue: NostrEvent): ComplexitySignal | Promise<ComplexitySignal>;
}

/** Title (subject tag) + body text of an issue, lowercased for matching. */
function issueText(issue: NostrEvent): { subject: string; body: string } {
  const subject = issue.tags.find((t) => t[0] === "subject")?.[1] ?? "";
  return { subject, body: issue.content ?? "" };
}

// Keyword signals. Small, high-signal lists — not an attempt at NLP, just a
// reasonable default until LLM triage is wired.
const SMALL_HINTS = [
  "typo", "docs", "documentation", "readme", "comment", "rename", "lint",
  "format", "whitespace", "link", "bump", "changelog", "wording", "spelling",
];
const LARGE_HINTS = [
  "refactor", "redesign", "rewrite", "architecture", "migrate", "migration",
  "overhaul", "breaking", "across", "everywhere", "all of", "rework",
  "protocol", "backwards", "concurren", "race condition",
];

export function heuristicScore(issue: NostrEvent): ComplexitySignal {
  const { subject, body } = issueText(issue);
  const hay = `${subject}\n${body}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // size of the description
  const len = body.length;
  if (len > 1200) {
    score += 2;
    reasons.push("long description (>1200 chars)");
  } else if (len < 200) {
    score -= 1;
    reasons.push("short description (<200 chars)");
  }

  // checklists usually mean multi-step work
  const checkboxes = (body.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? []).length;
  if (checkboxes >= 3) {
    score += 2;
    reasons.push(`${checkboxes} checklist items`);
  } else if (checkboxes > 0) {
    score += 1;
    reasons.push(`${checkboxes} checklist item(s)`);
  }

  // multiple code blocks suggest cross-cutting changes
  const fences = (body.match(/```/g) ?? []).length;
  const codeBlocks = Math.floor(fences / 2);
  if (codeBlocks >= 2) {
    score += 1;
    reasons.push(`${codeBlocks} code blocks`);
  }

  // keyword signals
  const small = SMALL_HINTS.filter((k) => hay.includes(k));
  const large = LARGE_HINTS.filter((k) => hay.includes(k));
  if (small.length) {
    score -= 2;
    reasons.push(`small-task hints: ${small.join(", ")}`);
  }
  if (large.length) {
    score += 2;
    reasons.push(`large-task hints: ${large.join(", ")}`);
  }

  // map score -> bucket. thresholds chosen so a bare issue lands at M.
  const complexity: Complexity = score <= -2 ? "S" : score >= 3 ? "L" : "M";
  if (reasons.length === 0) reasons.push("no strong signals; defaulted to M");
  return { complexity, score, reasons };
}

/** The default scorer: pure, deterministic, offline. */
export const heuristicScorer: ComplexityScorer = {
  score: heuristicScore,
};
