import { describe, it, expect } from "vitest";
import { repoClone } from "../src/nip34";
import { NostrEvent, KIND } from "../src/types";

const ann = (tags: string[][]): NostrEvent => ({
  id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1,
  kind: KIND.REPO_ANNOUNCEMENT, tags, content: "",
});

describe("repoClone", () => {
  it("returns all clone urls across one or more `clone` tags, deduped", () => {
    const r = ann([["clone", "https://a.git", "https://b.git"], ["clone", "https://a.git"]]);
    expect(repoClone(r)).toEqual(["https://a.git", "https://b.git"]);
  });
  it("returns [] when there is no clone tag", () => {
    expect(repoClone(ann([["relays", "wss://x"]]))).toEqual([]);
  });
});
