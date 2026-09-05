import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const SP_HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SELLER_ID = "A2ZPQEA709W727";

// Landed cost per unit in USD. Amazon never knows what you paid the supplier,
// so contribution margin is only as honest as what is typed here.
// Copper bottle: $14.00 is the supplier's claim, $18.17 is the honest air-freight
// arithmetic. Update when the real landed cost is confirmed in writing.
const COGS: Record<string, number> = {
	// "AH-COPPER-1L": 18.17,
};

let currentEnv: any = null;
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

/* ------------------------------------------------------------------ */
/*  AUTH + TRANSPORT                                                   */
/* ------------------------------------------------------------------ */

async function getAccessToken(): Promise<string> {
	const now = Date.now();
	if (cachedToken && now < cachedTokenExpiry) return cachedToken;

	const res = await fetch("https://api.amazon.com/auth/o2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: currentEnv.SP_REFRESH_TOKEN,
			client_id: currentEnv.SP_CLIENT_ID,
			client_secret: currentEnv.SP_CLIENT_SECRET,
		}).toString(),
	});

	if (!res.ok) {
		throw new Error("Token request failed " + res.status + ": " + (await res.text()));
	}

	const data: any = await res.json();
	cachedToken = data.access_token;
	cachedTokenExpiry = now + (data.expires_in - 120) * 1000;
	return cachedToken as string;
}

async function spGet(path: string): Promise<any> {
	const token = await getAccessToken();

	// SP-API throttles hard. Retry on 429 and 5xx with a short backoff.
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(SP_HOST + path, {
			headers: {
				"x-amz-access-token": token,
				"Content-Type": "application/json",
			},
		});

		if (res.status === 429 || res.status >= 500) {
			await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
			continue;
		}

		const text = await res.text();
		if (!res.ok) throw new Error("SP-API " + res.status + ": " + text.slice(0, 400));
		return JSON.parse(text);
	}

	throw new Error("SP-API throttled after 4 attempts");
}

/**
 * Follows NextToken until every page is read.
 * Without this the tools silently report only the first 100 results —
 * invisible at 12 orders a month, wrong the moment volume arrives.
 */
async function spGetAllPages(
	basePath: string,
	extract: (payload: any) => any[],
	tokenParam: string,
	maxPages = 20
): Promise<{ items: any[]; pages: number; truncated: boolean }> {
	const items: any[] = [];
	let nextToken: string | null = null;
	let pages = 0;

	do {
		const path = nextToken
			? basePath.split("?")[0] + "?" + tokenParam + "=" + encodeURIComponent(nextToken)
			: basePath;

		const data = await spGet(path);
		const payload = data?.payload ?? data;
		items.push(...extract(payload));
		nextToken = payload?.NextToken ?? payload?.nextToken ?? null;
		pages++;
	} while (nextToken && pages < maxPages);

	return { items, pages, truncated: Boolean(nextToken) };
}

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

function daysAgoISO(days: number): string {
	return new Date(Date.now() - days * 86400000).toISOString();
}

function money(n: number): string {
	return n.toFixed(2);
}

function textResult(obj: any) {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(e: any) {
	return { content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }] };
}

/** Pulls a currency amount out of any of the shapes Amazon uses. */
function amountOf(node: any): number {
	if (!node || typeof node !== "object") return 0;
	const v =
		node.CurrencyAmount ??
		node.Amount ??
		node.amount ??
		node.currencyAmount ??
		null;
	return v === null ? 0 : Number(v) || 0;
}

/**
 * Walks any financial event object and totals every currency amount inside it,
 * whatever the nesting. This is why the tool does not need to know the 30 event
 * list names: a new event type Amazon adds is counted automatically instead of
 * being silently dropped.
 */
function sumAllAmounts(node: any, depth = 0): number {
	if (!node || depth > 8) return 0;

	if (Array.isArray(node)) {
		return node.reduce((t, n) => t + sumAllAmounts(n, depth + 1), 0);
	}

	if (typeof node !== "object") return 0;

	// A leaf currency object — take it and stop descending.
	const direct = amountOf(node);
	if (direct !== 0 && (node.CurrencyCode || node.currencyCode)) return direct;

	let total = 0;
	for (const key of Object.keys(node)) {
		if (key === "PostedDate" || key === "postedDate") continue;
		total += sumAllAmounts(node[key], depth + 1);
	}
	return total;
}

/** Human-readable label for an event list key. */
function prettify(key: string): string {
	return key
		.replace(/EventList$/, "")
		.replace(/List$/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/* ------------------------------------------------------------------ */
/*  SERVER                                                             */
/* ------------------------------------------------------------------ */

function createServer() {
	const server = new McpServer({
		name: "AH Inside Seller Central",
		version: "2.0.0",
	});

	/* ---------------- INVENTORY ---------------- */

	server.registerTool(
		"get_inventory",
		{
			description:
				"Current FBA inventory for every SKU in the US marketplace: fulfillable, inbound, reserved and unfulfillable units. Follows pagination.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const base =
					"/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=" +
					MARKETPLACE_ID +
					"&marketplaceIds=" +
					MARKETPLACE_ID +
					"&details=true";

				const { items, truncated } = await spGetAllPages(
					base,
					(p) => p?.inventorySummaries || [],
					"nextToken"
				);

				const rows = items.map((s: any) => {
					const d = s.inventoryDetails || {};
					return {
						sku: s.sellerSku,
						asin: s.asin,
						name: s.productName,
						fulfillable: d.fulfillableQuantity ?? 0,
						inbound_working: d.inboundWorkingQuantity ?? 0,
						inbound_shipped: d.inboundShippedQuantity ?? 0,
						inbound_receiving: d.inboundReceivingQuantity ?? 0,
						reserved: d.reservedQuantity?.totalReservedQuantity ?? 0,
						unfulfillable: d.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
						researching: d.researchingQuantity?.totalResearchingQuantity ?? 0,
						total: s.totalQuantity ?? 0,
					};
				});

				const totals = rows.reduce(
					(t: any, r: any) => ({
						fulfillable: t.fulfillable + r.fulfillable,
						inbound: t.inbound + r.inbound_working + r.inbound_shipped + r.inbound_receiving,
						reserved: t.reserved + r.reserved,
						unfulfillable: t.unfulfillable + r.unfulfillable,
					}),
					{ fulfillable: 0, inbound: 0, reserved: 0, unfulfillable: 0 }
				);

				return textResult({
					sku_count: rows.length,
					totals,
					truncated,
					inventory: rows,
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ---------------- FINANCIALS ---------------- */

	server.registerTool(
		"get_financials",
		{
			description:
				"Complete financial picture for a period: revenue, referral and FBA fees, ADVERTISING SPEND, coupons, storage, subscription, refunds and every other event type Amazon reports. Reads all pages and every event list, so nothing is dropped. Default 30 days.",
			inputSchema: z.object({
				days: z
					.number()
					.optional()
					.describe("Days to look back. Default 30. Large windows take longer."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.max(1, days ?? 30);
				const base =
					"/finances/v0/financialEvents?PostedAfter=" +
					encodeURIComponent(daysAgoISO(window)) +
					"&MaxResultsPerPage=100";

				// Collect every page's FinancialEvents object.
				const groups: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;
				let truncated = false;

				do {
					const path = nextToken
						? "/finances/v0/financialEvents?NextToken=" + encodeURIComponent(nextToken)
						: base;
					const data = await spGet(path);
					const payload = data?.payload || {};
					if (payload.FinancialEvents) groups.push(payload.FinancialEvents);
					nextToken = payload.NextToken || null;
					pages++;
					if (pages >= 30 && nextToken) {
						truncated = true;
						break;
					}
				} while (nextToken);

				/* --- every event list, counted and totalled generically --- */

				const byList: Record<string, { events: number; usd: number }> = {};

				for (const g of groups) {
					for (const key of Object.keys(g)) {
						const list = g[key];
						if (!Array.isArray(list) || list.length === 0) continue;
						if (!byList[key]) byList[key] = { events: 0, usd: 0 };
						byList[key].events += list.length;
						byList[key].usd += sumAllAmounts(list);
					}
				}

				/* --- shipment events broken down properly, and per SKU --- */

				let revenue = 0;
				let itemFees = 0;
				let promotions = 0;
				let units = 0;

				const perSku: Record<
					string,
					{ units: number; revenue: number; fees: number; promos: number; refunds: number; refund_units: number }
				> = {};

				const bucket = (sku: string) => {
					if (!perSku[sku])
						perSku[sku] = { units: 0, revenue: 0, fees: 0, promos: 0, refunds: 0, refund_units: 0 };
					return perSku[sku];
				};

				for (const g of groups) {
					for (const s of g.ShipmentEventList || []) {
						for (const item of s.ShipmentItemList || []) {
							const sku = item.SellerSKU || "UNKNOWN";
							const b = bucket(sku);
							const qty = Number(item.QuantityShipped || 0);
							b.units += qty;
							units += qty;

							for (const c of item.ItemChargeList || []) {
								const v = amountOf(c.ChargeAmount);
								revenue += v;
								b.revenue += v;
							}
							for (const f of item.ItemFeeList || []) {
								const v = amountOf(f.FeeAmount);
								itemFees += v;
								b.fees += v;
							}
							for (const p of item.PromotionList || []) {
								const v = amountOf(p.PromotionAmount);
								promotions += v;
								b.promos += v;
							}
						}
					}

					for (const r of g.RefundEventList || []) {
						for (const item of r.ShipmentItemAdjustmentList || []) {
							const sku = item.SellerSKU || "UNKNOWN";
							const b = bucket(sku);
							b.refund_units += Math.abs(Number(item.QuantityShipped || 0));
							for (const c of item.ItemChargeAdjustmentList || []) {
								b.refunds += amountOf(c.ChargeAmount);
							}
						}
					}
				}

				/* --- named lines pulled out of the generic table --- */

				const line = (k: string) => byList[k]?.usd || 0;
				const count = (k: string) => byList[k]?.events || 0;

				const advertising = line("ProductAdsPaymentEventList");
				const serviceFees = line("ServiceFeeEventList");
				const coupons = line("CouponPaymentEventList");
				const deals = line("SellerDealPaymentEventList");
				const refunds = line("RefundEventList");
				const adjustments = line("AdjustmentEventList");
				const debtRecovery = line("DebtRecoveryEventList");
				const liquidations = line("FBALiquidationEventList");
				const removals = line("RemovalShipmentEventList");

				/* --- everything the named lines did not claim --- */

				const namedKeys = new Set([
					"ShipmentEventList",
					"ProductAdsPaymentEventList",
					"ServiceFeeEventList",
					"CouponPaymentEventList",
					"SellerDealPaymentEventList",
					"RefundEventList",
					"AdjustmentEventList",
					"DebtRecoveryEventList",
					"FBALiquidationEventList",
					"RemovalShipmentEventList",
				]);

				let otherTotal = 0;
				const otherLists: Record<string, string> = {};
				for (const [k, v] of Object.entries(byList)) {
					if (namedKeys.has(k)) continue;
					otherTotal += v.usd;
					otherLists[prettify(k)] = money(v.usd) + " (" + v.events + " events)";
				}

				const totalCosts =
					itemFees + promotions + advertising + serviceFees + coupons + deals + refunds;

				/* --- per-SKU table with contribution if COGS is known --- */

				const skuRows = Object.entries(perSku)
					.map(([sku, v]) => {
						const net = v.revenue + v.fees + v.promos + v.refunds;
						const cogs = COGS[sku];
						const row: any = {
							sku,
							units: v.units,
							revenue_usd: money(v.revenue),
							fees_usd: money(v.fees),
							promotions_usd: money(v.promos),
							refunds_usd: money(v.refunds),
							refund_units: v.refund_units,
							net_after_amazon_usd: money(net),
							net_per_unit_usd: v.units ? money(net / v.units) : "0.00",
						};
						if (cogs !== undefined && v.units) {
							row.cogs_usd = money(cogs * v.units);
							row.contribution_usd = money(net - cogs * v.units);
							row.contribution_per_unit_usd = money(net / v.units - cogs);
						}
						return row;
					})
					.sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd));

				return textResult({
					period_days: window,
					pages_read: pages,
					truncated,

					summary: {
						revenue_usd: money(revenue),
						units_shipped: units,
						referral_and_fba_fees_usd: money(itemFees),
						promotions_usd: money(promotions),
						advertising_usd: money(advertising),
						service_fees_usd: money(serviceFees),
						coupons_usd: money(coupons),
						deals_usd: money(deals),
						refunds_usd: money(refunds),
						other_usd: money(otherTotal),
						total_costs_usd: money(totalCosts),
						net_usd: money(revenue + totalCosts + adjustments + debtRecovery + liquidations + removals),
					},

					event_counts: {
						shipments: count("ShipmentEventList"),
						refunds: count("RefundEventList"),
						service_fees: count("ServiceFeeEventList"),
						advertising: count("ProductAdsPaymentEventList"),
						coupons: count("CouponPaymentEventList"),
					},

					adjustments_and_other: {
						adjustments_usd: money(adjustments),
						debt_recovery_usd: money(debtRecovery),
						liquidations_usd: money(liquidations),
						removals_usd: money(removals),
						other_event_lists: otherLists,
					},

					per_sku: skuRows,

					all_event_lists: Object.fromEntries(
						Object.entries(byList).map(([k, v]) => [
							prettify(k),
							{ events: v.events, usd: money(v.usd) },
						])
					),

					note:
						"Landed cost is not available from Amazon. Contribution appears only for SKUs listed in the COGS constant at the top of the Worker source. Advertising here is total spend; clicks, CPC and ACOS require the Amazon Ads API.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ---------------- ORDERS ---------------- */

	server.registerTool(
		"get_order_summary",
		{
			description:
				"Order counts, units, gross revenue and status breakdown for a period. Optionally includes a per-SKU breakdown. Returns no buyer names or addresses. Default 30 days.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30."),
				include_skus: z
					.boolean()
					.optional()
					.describe("Fetch line items per order for a SKU breakdown. Slower on large windows."),
			}),
		},
		async ({ days, include_skus }: any) => {
			try {
				const window = Math.max(1, days ?? 30);
				const base =
					"/orders/v0/orders?MarketplaceIds=" +
					MARKETPLACE_ID +
					"&CreatedAfter=" +
					encodeURIComponent(daysAgoISO(window)) +
					"&MaxResultsPerPage=100";

				const orders: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;
				let truncated = false;

				do {
					const path = nextToken
						? "/orders/v0/orders?MarketplaceIds=" +
						  MARKETPLACE_ID +
						  "&NextToken=" +
						  encodeURIComponent(nextToken)
						: base;
					const data = await spGet(path);
					const payload = data?.payload || {};
					orders.push(...(payload.Orders || []));
					nextToken = payload.NextToken || null;
					pages++;
					if (pages >= 20 && nextToken) {
						truncated = true;
						break;
					}
				} while (nextToken);

				const byStatus: Record<string, number> = {};
				const byChannel: Record<string, number> = {};
				let gross = 0;
				let units = 0;

				for (const o of orders) {
					byStatus[o.OrderStatus] = (byStatus[o.OrderStatus] || 0) + 1;
					const ch = o.FulfillmentChannel || "unknown";
					byChannel[ch] = (byChannel[ch] || 0) + 1;
					gross += amountOf(o.OrderTotal);
					units += Number(o.NumberOfItemsShipped || 0) + Number(o.NumberOfItemsUnshipped || 0);
				}

				const out: any = {
					period_days: window,
					pages_read: pages,
					truncated,
					order_count: orders.length,
					units,
					gross_usd: money(gross),
					average_order_value_usd: orders.length ? money(gross / orders.length) : "0.00",
					by_status: byStatus,
					by_fulfillment_channel: byChannel,
				};

				// Per-SKU needs one call per order, so it is opt-in and capped.
				if (include_skus) {
					const perSku: Record<string, { units: number; revenue: number; orders: number }> = {};
					const cap = Math.min(orders.length, 60);

					for (let i = 0; i < cap; i++) {
						const id = orders[i].AmazonOrderId;
						try {
							const d = await spGet("/orders/v0/orders/" + id + "/orderItems");
							for (const it of d?.payload?.OrderItems || []) {
								const sku = it.SellerSKU || "UNKNOWN";
								if (!perSku[sku]) perSku[sku] = { units: 0, revenue: 0, orders: 0 };
								perSku[sku].units += Number(it.QuantityOrdered || 0);
								perSku[sku].revenue += amountOf(it.ItemPrice);
								perSku[sku].orders += 1;
							}
						} catch {
							// One bad order must not kill the whole report.
						}
					}

					out.per_sku = Object.entries(perSku)
						.map(([sku, v]) => ({
							sku,
							units: v.units,
							orders: v.orders,
							revenue_usd: money(v.revenue),
						}))
						.sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd));

					out.per_sku_note =
						"Based on the first " + cap + " of " + orders.length + " orders.";
				}

				return textResult(out);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ---------------- LISTINGS ---------------- */

	server.registerTool(
		"list_skus",
		{
			description:
				"Every SKU on the account with its ASIN, title, status and any listing issues. Use this to find the exact SKU string before calling get_listing.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const base =
					"/listings/2021-08-01/items/" +
					SELLER_ID +
					"?marketplaceIds=" +
					MARKETPLACE_ID +
					"&includedData=summaries,issues&pageSize=20";

				const items: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;

				do {
					const path = nextToken
						? "/listings/2021-08-01/items/" +
						  SELLER_ID +
						  "?marketplaceIds=" +
						  MARKETPLACE_ID +
						  "&includedData=summaries,issues&pageSize=20&pageToken=" +
						  encodeURIComponent(nextToken)
						: base;
					const data = await spGet(path);
					items.push(...(data?.items || []));
					nextToken = data?.pagination?.nextToken || null;
					pages++;
				} while (nextToken && pages < 20);

				const rows = items.map((i: any) => {
					const s = (i.summaries || [])[0] || {};
					const issues = i.issues || [];
					return {
						sku: i.sku,
						asin: s.asin,
						title: s.itemName,
						status: (s.status || []).join(", "),
						condition: s.conditionType,
						created: s.createdDate,
						issue_count: issues.length,
						issues: issues.map((x: any) => x.code + ": " + x.message).slice(0, 5),
					};
				});

				return textResult({ sku_count: rows.length, skus: rows });
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"get_listing",
		{
			description:
				"Full listing detail for one SKU: attributes, bullet points, status, offers, fulfilment availability and listing issues. Use list_skus first if the exact SKU string is unknown.",
			inputSchema: z.object({
				sku: z.string().describe("The seller SKU exactly as it appears in Seller Central."),
			}),
		},
		async ({ sku }: any) => {
			try {
				const data = await spGet(
					"/listings/2021-08-01/items/" +
						SELLER_ID +
						"/" +
						encodeURIComponent(sku) +
						"?marketplaceIds=" +
						MARKETPLACE_ID +
						"&includedData=summaries,attributes,issues,offers,fulfillmentAvailability,procurement"
				);
				return textResult(data);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ---------------- SETTLEMENTS ---------------- */

	server.registerTool(
		"get_settlements",
		{
			description:
				"Settlement periods and payout balances — when Amazon paid out, how much, and what is still held in reserve.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 90."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.max(1, days ?? 90);
				const data = await spGet(
					"/finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=" +
						encodeURIComponent(daysAgoISO(window)) +
						"&MaxResultsPerPage=100"
				);

				const groups = (data?.payload?.FinancialEventGroupList || []).map((g: any) => ({
					group_id: g.FinancialEventGroupId,
					status: g.ProcessingStatus,
					started: g.FinancialEventGroupStart,
					ended: g.FinancialEventGroupEnd,
					fund_transfer_status: g.FundTransferStatus,
					original_total_usd: money(amountOf(g.OriginalTotal)),
					converted_total_usd: money(amountOf(g.ConvertedTotal)),
					beginning_balance_usd: money(amountOf(g.BeginningBalance)),
					fund_transfer_date: g.FundTransferDate,
					trace_id: g.TraceId,
				}));

				return textResult({ period_days: window, count: groups.length, settlements: groups });
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: any, ctx: ExecutionContext) {
		currentEnv = env;

		const url = new URL(request.url);
		const gate = env.ACCESS_KEY;

		// The access key must be the first path segment, so the bare
		// workers.dev URL on its own returns nothing.
		if (!gate || !url.pathname.startsWith("/" + gate)) {
			return new Response("Not found", { status: 404 });
		}

		const inner = url.pathname.slice(gate.length + 1) || "/";
		const rewritten = new URL(request.url);
		rewritten.pathname = inner;

		return handler(new Request(rewritten.toString(), request), env, ctx);
	},
};
