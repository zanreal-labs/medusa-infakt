import { describe, expect, it } from "vitest";
import type { ClassifiableLine } from "./classification";
import { classifyOrderSupply } from "./classification";

const line = (overrides: Partial<ClassifiableLine> = {}): ClassifiableLine => ({
  name: "Bitdefender Pro Security",
  ...overrides,
});

describe("classifyOrderSupply", () => {
  it("reads a marker off the line itself", () => {
    expect(classifyOrderSupply([line({ metadata: { tax_supply: "service" } })])).toEqual({
      supply: "service",
    });
  });

  it("falls back to the variant, then the product", () => {
    expect(classifyOrderSupply([line({ variantMetadata: { tax_supply: "goods" } })])).toEqual({
      supply: "goods",
    });
    expect(classifyOrderSupply([line({ productMetadata: { tax_supply: "goods" } })])).toEqual({
      supply: "goods",
    });
  });

  it("lets a line-level marker override the product, for one-off corrections", () => {
    expect(
      classifyOrderSupply([
        line({ metadata: { tax_supply: "goods" }, productMetadata: { tax_supply: "service" } }),
      ]),
    ).toEqual({ supply: "goods" });
  });

  it("accepts the spellings a human would actually type", () => {
    for (const value of ["service", "SERVICE", " electronic ", "digital", "usluga"]) {
      expect(classifyOrderSupply([line({ metadata: { tax_supply: value } })]), value).toEqual({
        supply: "service",
      });
    }
    for (const value of ["goods", "Merchandise", "physical", "towar"]) {
      expect(classifyOrderSupply([line({ metadata: { tax_supply: value } })]), value).toEqual({
        supply: "goods",
      });
    }
  });

  it("accepts the alternative key spellings", () => {
    for (const key of ["tax_supply", "taxSupply", "supply_kind", "supplyKind", "vat_supply"]) {
      expect(classifyOrderSupply([line({ metadata: { [key]: "service" } })]), key).toEqual({
        supply: "service",
      });
    }
  });

  it("reports unknown for an untagged product, naming it so it can be fixed", () => {
    const result = classifyOrderSupply([line({ name: "DJI Mini 5 Pro" })]);
    expect(result.supply).toBe("unknown");
    expect("reason" in result && result.reason).toContain("DJI Mini 5 Pro");
    expect("reason" in result && result.reason).toContain("tax_supply");
  });

  it("does not list more than three unclassified products", () => {
    const result = classifyOrderSupply([
      line({ name: "A" }),
      line({ name: "B" }),
      line({ name: "C" }),
      line({ name: "D" }),
      line({ name: "E" }),
    ]);
    expect("reason" in result && result.reason).toContain("and 2 more");
  });

  it("reports mixed when the lines disagree, rather than picking a side", () => {
    const result = classifyOrderSupply([
      line({ metadata: { tax_supply: "service" } }),
      line({ metadata: { tax_supply: "goods" } }),
    ]);
    expect(result.supply).toBe("mixed");
  });

  it("treats one untagged line among tagged ones as unknown, not as the majority", () => {
    const result = classifyOrderSupply([
      line({ metadata: { tax_supply: "service" } }),
      line({ name: "Untagged" }),
    ]);
    expect(result.supply).toBe("unknown");
    expect("reason" in result && result.reason).toContain("Untagged");
  });

  it("reports unknown for an empty order", () => {
    expect(classifyOrderSupply([]).supply).toBe("unknown");
  });

  it("ignores a marker value it does not understand", () => {
    const result = classifyOrderSupply([line({ metadata: { tax_supply: "banana" } })]);
    expect(result.supply).toBe("unknown");
  });

  it("ignores a non-string marker", () => {
    expect(classifyOrderSupply([line({ metadata: { tax_supply: 1 } })]).supply).toBe("unknown");
  });

  it("copes with an unnamed line", () => {
    const result = classifyOrderSupply([line({ name: null })]);
    expect("reason" in result && result.reason).toContain("an unnamed line");
  });
});
