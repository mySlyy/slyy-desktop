import { describe, expect, it } from "vitest";
import {
  formatSessionLink,
  isSessionLinkToken,
  MAX_SESSION_LINKS_PER_MESSAGE,
  parseSessionLinks,
  parseSessionLinkToken,
  sessionLinkSpans,
} from "./session-link.js";

describe("session links", () => {
  it("round-trips the link a session row copies", () => {
    const id = "6f1d2c3b-4a59-4e7f-8a90-b1c2d3e4f506";
    const link = formatSessionLink(id);
    expect(link).toBe(`slyy://session/${id}`);
    expect(parseSessionLinks(`please look at ${link} first`)).toEqual([id]);
  });

  it("keeps first-mention order and drops duplicates", () => {
    const text = [
      formatSessionLink("aaa"),
      formatSessionLink("bbb"),
      formatSessionLink("aaa"),
    ].join(" and ");
    expect(parseSessionLinks(text)).toEqual(["aaa", "bbb"]);
  });

  it("stops at the message bound", () => {
    const text = Array.from({ length: MAX_SESSION_LINKS_PER_MESSAGE + 3 }, (_, index) =>
      formatSessionLink(`session-${index}`),
    ).join(" ");
    expect(parseSessionLinks(text)).toHaveLength(MAX_SESSION_LINKS_PER_MESSAGE);
  });

  it("ignores prose, other schemes and remote ids", () => {
    expect(parseSessionLinks("")).toEqual([]);
    expect(parseSessionLinks("no links here")).toEqual([]);
    // A remote session id carries a colon, so it never parses as a local link.
    expect(parseSessionLinks("slyy://session/remote:abc")).toEqual([]);
    expect(parseSessionLinks("pi-desktop://session/remote:abc")).toEqual([]);
    expect(parseSessionLinks("https://example.com/session/abc")).toEqual([]);
    expect(parseSessionLinks("slyy://session/")).toEqual([]);
    expect(parseSessionLinks("pi-desktop://session/")).toEqual([]);
  });

  it("recognizes one token without scanning prose", () => {
    expect(isSessionLinkToken(formatSessionLink("abc"))).toBe(true);
    expect(isSessionLinkToken("@src/index.ts")).toBe(false);
  });
  it("names the id only when the whole token is one link", () => {
    expect(parseSessionLinkToken(formatSessionLink("abc"))).toBe("abc");
    expect(parseSessionLinkToken(`  ${formatSessionLink("abc")}  `)).toBe("abc");
    expect(parseSessionLinkToken(`see ${formatSessionLink("abc")}`)).toBeNull();
    expect(parseSessionLinkToken("slyy://session/")).toBeNull();
    expect(parseSessionLinkToken("pi-desktop://session/")).toBeNull();
    expect(parseSessionLinkToken("@src/index.ts")).toBeNull();
  });

  it("reports every link span in text order", () => {
    const text = `first ${formatSessionLink("aaa")} then ${formatSessionLink("bbb")}`;
    const spans = sessionLinkSpans(text);
    expect(spans.map((span) => span.id)).toEqual(["aaa", "bbb"]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(formatSessionLink("aaa"));
    expect(text.slice(spans[1].start, spans[1].end)).toBe(formatSessionLink("bbb"));
    expect(sessionLinkSpans("nothing here")).toEqual([]);
  });

  it("still accepts links copied before the rebrand, but never produces them", () => {
    const legacy = "pi-desktop://session/abc";
    expect(parseSessionLinks(`see ${legacy} and ${formatSessionLink("def")}`)).toEqual(["abc", "def"]);
    expect(isSessionLinkToken(legacy)).toBe(true);
    expect(parseSessionLinkToken(legacy)).toBe("abc");
    const text = `first ${legacy} then ${formatSessionLink("def")}`;
    const spans = sessionLinkSpans(text);
    expect(spans.map((span) => span.id)).toEqual(["abc", "def"]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(legacy);
    expect(formatSessionLink("abc")).not.toContain("pi-desktop");
  });
});
