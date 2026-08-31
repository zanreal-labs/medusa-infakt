import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("describeError", () => {
  it("renders a plain object as something actionable, not [object Object]", () => {
    const rendered = describeError({ code: "invalid_data", type: "invalid_data" });
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("invalid_data");
  });

  it("reads a message off an object that is not an Error instance", () => {
    expect(describeError({ code: "invalid_data", message: "Country code cannot be changed" })).toBe(
      "Country code cannot be changed (invalid_data)",
    );
  });

  it("unwraps the workflow engine's errors[] rejection", () => {
    expect(
      describeError({ errors: [{ error: new Error("Country code cannot be changed") }] }),
    ).toBe("Country code cannot be changed");
  });

  it("still handles the ordinary cases", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("boom")).toBe("boom");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("names the type rather than throwing on a circular object", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).toContain("Object");
  });
});
