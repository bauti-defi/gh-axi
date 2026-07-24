import { describe, it, expect, afterEach } from "vitest";
import { gistIdFromSelector } from "../src/gistSelector.js";
import { AxiError } from "../src/errors.js";

const ID = "5b0e0062eb8e9654adad7bb1d81cc75f";

afterEach(() => {
  delete process.env["GH_HOST"];
});

describe("gistIdFromSelector", () => {
  describe("bare ids", () => {
    it("returns a bare gist id unchanged", () => {
      expect(gistIdFromSelector(ID)).toBe(ID);
    });

    it("accepts a short numeric id", () => {
      expect(gistIdFromSelector("1234")).toBe("1234");
    });
  });

  describe("urls", () => {
    it("extracts the id from an owner-scoped gist url", () => {
      expect(gistIdFromSelector(`https://gist.github.com/OWNER/${ID}`)).toBe(
        ID,
      );
    });

    it("extracts the id from an ownerless gist url", () => {
      expect(gistIdFromSelector(`https://gist.github.com/${ID}`)).toBe(ID);
    });

    it("tolerates a trailing slash", () => {
      expect(
        gistIdFromSelector(`https://gist.github.com/OWNER/${ID}/`),
      ).toBe(ID);
    });

    // gh's own GistIDFromURL takes path segment [2], which yields "OWNER" for
    // this GHE shape. Taking the last segment is correct for every shape.
    it("extracts the id from a GHE /gist/OWNER/ID url", () => {
      process.env["GH_HOST"] = "ghe.example.com";
      expect(
        gistIdFromSelector(`https://ghe.example.com/gist/OWNER/${ID}`),
      ).toBe(ID);
    });

    it("accepts the bare configured host without a gist subdomain", () => {
      process.env["GH_HOST"] = "ghe.example.com";
      expect(gistIdFromSelector(`https://ghe.example.com/${ID}`)).toBe(ID);
    });
  });

  describe("host validation", () => {
    it("rejects a url pointing at a different host than configured", () => {
      process.env["GH_HOST"] = "ghe.example.com";
      expect(() =>
        gistIdFromSelector(`https://gist.github.com/OWNER/${ID}`),
      ).toThrow(AxiError);
    });

    it("names the configured host in the mismatch error", () => {
      process.env["GH_HOST"] = "ghe.example.com";
      expect(() =>
        gistIdFromSelector(`https://gist.github.com/OWNER/${ID}`),
      ).toThrow(/ghe\.example\.com/);
    });

    it("accepts gist.github.com by default", () => {
      expect(
        gistIdFromSelector(`https://gist.github.com/OWNER/${ID}`),
      ).toBe(ID);
    });

    it("accepts github.com by default", () => {
      expect(gistIdFromSelector(`https://github.com/OWNER/${ID}`)).toBe(ID);
    });
  });

  describe("invalid input", () => {
    it("rejects an empty selector", () => {
      expect(() => gistIdFromSelector("")).toThrow(AxiError);
    });

    it("rejects a whitespace-only selector", () => {
      expect(() => gistIdFromSelector("   ")).toThrow(AxiError);
    });

    it("rejects a url with no id segment", () => {
      expect(() => gistIdFromSelector("https://gist.github.com/")).toThrow(
        AxiError,
      );
    });

    it("rejects a selector containing whitespace", () => {
      expect(() => gistIdFromSelector("abc def")).toThrow(AxiError);
    });

    it("throws VALIDATION_ERROR for bad input", () => {
      try {
        gistIdFromSelector("");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as AxiError).code).toBe("VALIDATION_ERROR");
      }
    });
  });
});
