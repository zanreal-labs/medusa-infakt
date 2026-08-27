/**
 * What each order line is, for VAT purposes.
 *
 * The place of supply of a service follows the customer; the place of supply of
 * goods follows the goods. So before the destination can decide anything, the
 * plugin has to know which it is holding - and it has to know it from the
 * product, not from the shipping address. Inferring "this went to Germany, so
 * it must be one of our license keys" works right up until the first physical
 * item is sold abroad, and then it silently applies a services regime to goods.
 * A drone has already been sold through this store, so that is not hypothetical.
 *
 * Deliberately blocking rather than defaulting: an unclassified product is only
 * a problem cross-border, because a domestic sale is 23% whether it is a service
 * or a widget. So an unmarked catalogue keeps working exactly as it does today
 * for Polish orders, and the first foreign order for an unmarked product parks
 * with a reason naming the product. That is the cheapest possible migration - no
 * backfill needed before shipping, and no silent wrong answer either.
 */

import type { SupplyKind } from "./regime";

/**
 * Metadata keys checked on the line, its variant and its product, in that order.
 *
 * Several spellings are accepted because this marker is set by whoever maintains
 * the catalogue, in an admin field, by hand.
 */
const SUPPLY_KEYS = ["tax_supply", "taxSupply", "supply_kind", "supplyKind", "vat_supply"] as const;

/** Marker values understood as an electronically supplied service. */
const SERVICE_VALUES = new Set([
  "service",
  "services",
  "electronic",
  "electronic_service",
  "electronically_supplied_service",
  "digital",
  "usluga",
  "uslugi",
]);

/** Marker values understood as goods. */
const GOODS_VALUES = new Set(["goods", "merchandise", "physical", "product", "towar", "towary"]);

/** One line, reduced to just the places a marker can live. */
export interface ClassifiableLine {
  /** Display name, used only to name an unclassified product in a reason. */
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  variantMetadata?: Record<string, unknown> | null;
  productMetadata?: Record<string, unknown> | null;
}

export type ClassificationResult =
  | { supply: SupplyKind }
  | { supply: "unknown"; reason: string }
  | { supply: "mixed"; reason: string };

/**
 * Classify a whole order.
 *
 * An order whose lines disagree is `mixed` rather than resolved by majority or
 * by first line: a single invoice covering both a service and goods to a foreign
 * buyer needs two different treatments on one document, which this plugin does
 * not build. A human splits it.
 */
export function classifyOrderSupply(lines: readonly ClassifiableLine[]): ClassificationResult {
  if (lines.length === 0) {
    return { reason: "the order has no lines to classify", supply: "unknown" };
  }

  const seen = new Set<SupplyKind>();
  const unclassified: string[] = [];

  for (const line of lines) {
    const kind = classifyLine(line);
    if (kind === null) {
      unclassified.push(describeLine(line));
      continue;
    }
    seen.add(kind);
  }

  if (unclassified.length > 0) {
    // Naming the products is safe - a catalogue name is not buyer data - and it
    // is the whole value of the message, because the fix is to tag that product.
    return {
      reason: `not classified for VAT: ${unclassified.slice(0, 3).join(", ")}${unclassified.length > 3 ? ` and ${unclassified.length - 3} more` : ""} - set metadata.tax_supply to "service" or "goods"`,
      supply: "unknown",
    };
  }

  if (seen.size > 1) {
    return {
      reason: "the order mixes services and goods, which need different VAT treatments on one invoice",
      supply: "mixed",
    };
  }

  const [only] = [...seen];
  return { supply: only ?? "unknown" };
}

function classifyLine(line: ClassifiableLine): SupplyKind | null {
  for (const source of [line.metadata, line.variantMetadata, line.productMetadata]) {
    const value = readSupplyMarker(source);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function readSupplyMarker(metadata: Record<string, unknown> | null | undefined): SupplyKind | null {
  if (!metadata) {
    return null;
  }
  for (const key of SUPPLY_KEYS) {
    const raw = metadata[key];
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (SERVICE_VALUES.has(normalized)) {
      return "service";
    }
    if (GOODS_VALUES.has(normalized)) {
      return "goods";
    }
  }
  return null;
}

const describeLine = (line: ClassifiableLine): string => line.name?.trim() || "an unnamed line";
