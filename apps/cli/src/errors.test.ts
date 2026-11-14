import { describe, expect, it } from "vitest";
import { errorMessage, errorText } from "./errors.js";

describe("errorMessage and errorText", () => {
  it("read any thrown value; errorText drops one trailing full stop", () => {
    expect(errorMessage(new Error("Broke."))).toBe("Broke.");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorText(new Error("Broke."))).toBe("Broke");
    expect(errorText(42)).toBe("42");
  });
});
