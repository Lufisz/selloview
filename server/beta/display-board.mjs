// What a television may see of a store: board figures, a short order feed and stock alerts.
//
// The full snapshot also holds Shopify admin links and the shop's domain for the signed-in
// owner. A paired TV is a lower-trust device (a permanent cookie, a shared room), so those are
// removed here on the server instead of being hidden by the page. Orders keep only their
// number, time, amount and status: what a fulfillment screen needs, and no customer details.

function projectOrder(order) {
  return {
    number: order.number,
    createdAt: order.createdAt,
    amountCents: order.amountCents,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
  };
}

/**
 * @param {import('../metrics.mjs').Snapshot} snapshot
 * @param {{state: string, lastSuccessAt: string|null}} sync
 * @param {string|null} logoVersion  set when the store has a logo the TV can load
 */
export function projectBoardForDisplay(snapshot, sync, logoVersion = null) {
  return {
    source: snapshot.source,
    // No domain, no plan: the TV needs the name (and logo) for its heading, the rest for
    // formatting. The logo itself is served by MetricTV, so no Shopify address goes to the TV.
    shop: {
      name: snapshot.shop.name,
      currency: snapshot.shop.currency,
      timeZone: snapshot.shop.timeZone,
      plan: null,
      logoVersion,
    },
    fetchedAt: snapshot.fetchedAt,
    coverage: snapshot.coverage,
    periods: snapshot.periods,
    chart: snapshot.chart,
    charts: snapshot.charts,
    recentOrders: snapshot.recentOrders.map(projectOrder),
    // Titles and counts only; the links point into the Shopify admin and stay with the owner.
    attention: snapshot.attention.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
    })),
    backlog: snapshot.backlog,
    metricDefinition: snapshot.metricDefinition,
    sync: { state: sync.state, lastSuccessAt: sync.lastSuccessAt },
  };
}
