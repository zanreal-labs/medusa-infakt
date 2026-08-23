import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Container, Heading, Text } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { sdk } from "../lib/sdk";
import { buildInvoiceTimeline } from "../lib/timeline";
import type { InfaktInvoiceRow, InvoiceListResponse } from "../lib/types";

/**
 * The order's invoice milestones, in the RIGHT/side column of the order detail
 * page - directly below the native Medusa "Activity" timeline.
 *
 * ## Why a separate widget, in this exact zone
 *
 * The native 2.18 Activity timeline (`useActivityItems`) is a fully-enumerated
 * closed set: order placed, payments, fulfillments, returns/claims/exchanges,
 * order edits, transfers, a field-diff-only `update_order`, and cancel. `notes`
 * is a dead, unused array and there is no notes API in the dashboard. An invoice
 * maps to none of those concepts, and a plugin cannot inject a visible entry
 * without forking the dashboard bundle - so issuance and KSeF filing are surfaced
 * here instead, in zone `order.details.side.after`, which renders in the same
 * right column as, and immediately below, the Activity timeline. This keeps the
 * invoice's own timeline visually beside the order's, without abusing a
 * fulfillment or an address/email change to fake a native event.
 *
 * ## Read-only, best-effort, no PII
 *
 * It reads the one ledger row the same way the main widget does and renders
 * `buildInvoiceTimeline(row)` (pure, stably keyed, PII-free by construction). It
 * writes nothing and never crashes the order page: any load failure is swallowed
 * and the widget renders nothing at all. It also renders nothing when there is no
 * order id, no row, or no issued milestone yet (unissued / pending / skipped).
 */

interface WidgetOrder {
  id: string;
  display_id?: number;
}

const formatDate = (value?: string | null): string => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
};

const InfaktOrderActivityWidget = ({ data }: { data: WidgetOrder }) => {
  const { t } = useTranslation();
  const orderId = data?.id;
  const [row, setRow] = useState<InfaktInvoiceRow | undefined>();

  // One GET, best-effort. A missing row is a normal, silent state; a failed load
  // is swallowed so this companion widget can never break the order page - the
  // main operator panel above owns error reporting for invoicing.
  const load = useCallback(async () => {
    if (!orderId) {
      return;
    }
    try {
      const listResponse = await sdk.client.fetch<InvoiceListResponse>("/admin/infakt/invoices", {
        query: { limit: 1, order_id: orderId },
      });
      setRow(listResponse.invoices[0]);
    } catch {
      setRow(undefined);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!(orderId && row)) {
    return null;
  }

  const entries = buildInvoiceTimeline(row, (key, defaultValue, options) =>
    t(key, defaultValue, options),
  );
  if (entries.length === 0) {
    return null;
  }

  return (
    <Container className="flex flex-col gap-y-3 p-6">
      <Heading level="h2">
        {t("infakt.orderWidget.history.sideHeading", "Invoice history")}
      </Heading>
      <ul className="flex flex-col gap-y-2">
        {entries.map((entry) => (
          <li className="flex flex-wrap items-baseline justify-between gap-x-4" key={entry.key}>
            <Text className="txt-compact-small" size="small">
              {entry.title}
            </Text>
            <Text className="text-ui-fg-subtle txt-compact-small" size="small">
              {formatDate(entry.timestamp)}
            </Text>
          </li>
        ))}
      </ul>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
});

export default InfaktOrderActivityWidget;
