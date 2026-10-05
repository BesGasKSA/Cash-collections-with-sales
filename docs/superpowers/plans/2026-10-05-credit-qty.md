# Quantity per Credit Customer in the Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In every report that shows credit by customer, show the quantities too: per customer, per item and in total, alongside the amounts, so the user knows how many units (cylinders, regulators...) each credit customer took.

**Spec:** the user, 2026-10-05: "in the reports I can't know the quantity per credit customer; I need to be able to know the Qty too."

**Facts:** credit lines carry `creditCustomerId`, `creditSales`, and `creditItems [{productId, qty, unitPrice}]` (CLAUDE.md "Credit lines name a registered customer"); a file/area row may carry an amount with no items (then the quantity is unknown: show "—" with a count of such lines, never 0). `getSalesReport` returns `byCustomer` (credit amount per customer). Delivery fee and commission per unit are on the entry (`creditDeliveryFee`, `creditCommission`).

## Global Constraints
- Read-only; no change to saved entries or to `computeNet_`.
- Quantities from `creditItems` only (credit is already inside the product lines: never add the lines' qty again).
- Every string ar/en/ur; numbers: quantities as whole numbers (`exColKinds_` count/qty headers), money `#,##0.00`.

### Task 1
**Files:** `Collection.gs` (`actionSalesReport_`: `byCustomer[]` gains `qty`, `items: [{productId, qty, amount}]`, `linesWithoutQty`, `deliveryFee`, `commission`), `index.html` (the sales report's credit/customer views, the customer profile's activity, the pivot (`PV_DIMS_`/`PV_MEASURES_`: add customer as a dimension and credit quantity as a measure), Excel/PDF exports), `tests/run.js`.
- [ ] Tests first: two customers, three items, a line with items and one amount-only file row; assert per customer qty and per item qty/amount, `linesWithoutQty`, and that totals equal the sum of `creditItems`.
- [ ] Implement server, then client: the customer table gets Qty columns (total and per item, item columns only for items that have any credit), the customer profile's activity shows the same, the pivot can do customer › item › day with qty and amount; exports carry the qty columns.
- [ ] Browser check on the mock server (port 8912) in en/ar/ur; no console errors; `node tests/run.js` green; commit.
