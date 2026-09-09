import { connect } from "cloudflare:sockets";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const SP_HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SELLER_ID = "A2ZPQEA709W727";

/* ==================================================================
   v4.1 — 9 September 2026

   v4.0 unchanged in every respect. One tool added:

     proxy_test   Stage 1 test of the DataImpulse residential proxy
                  over a raw TCP socket. Cloudflare Workers' fetch()
                  has no proxy option, so the only in-Worker route to
                  a proxy is cloudflare:sockets connect(). This tool
                  proves whether that route works at all, using plain
                  HTTP to ip-api.com so no TLS can confuse the result.

                  A US residential IP in the response = proxy works.
                  An auth error = wrong PROXY_USER / PROXY_PASS.
                  An empty response = raw sockets blocked; fall back
                  to Cloudflare Browser Run.

   Secrets required in Cloudflare for this tool:
     PROXY_USER   DataImpulse login
     PROXY_PASS   DataImpulse password

   ------------------------------------------------------------------
   v4.0 — 5 September 2026

   v3 fixed the maths. v4 fills the gaps.

   NEW IN v4 — six tools, all inside the six roles already approved:

     get_traffic_and_conversion  Sessions, page views, UNIT SESSION
                                 PERCENTAGE (your real conversion rate)
                                 and Buy Box percentage, per ASIN, per day.
                                 This number has never been visible before.
                                 Every plan so far assumed 5% or 8.3%.
     run_report / get_report     Any SP-API report: returns, reimbursements,
                                 inventory ledger, Search Query Performance,
                                 estimated fees. Create-then-poll with GZIP
                                 decompression handled inside the Worker.
     get_competitive_pricing     Buy Box owner, lowest offer, offer count.
     estimate_fees               Referral + FBA fee for ANY price and ANY
                                 weight/dimensions, before you list.
                                 This settles Gate 2 without guessing.
     get_inbound_shipments       Track the 50 copper bottles in transit.
     get_sales_metrics           Units and revenue by day/week/month.

   WHY REPORTS ARE TWO TOOLS, NOT ONE
   Amazon generates a report asynchronously. It can take 30 seconds or
   ten minutes. A single tool that waits would time out and look broken.
   run_report waits up to ~55s and returns the data if ready, or a
   report_id. get_report(report_id) picks it up afterwards.

   STILL IMPOSSIBLE, WHATEVER THE CODE DOES
     Clicks, CPC, impressions, ACOS, keyword spend  → Amazon Ads API,
       a SEPARATE application. Not obtainable here at any price.
     Account Health score, reviews, star ratings, buyer messages
       → not exposed by SP-API at all.
     Landed cost → Amazon never knows what you paid your supplier.
     Deposit method settings → Seller Central screen only. This is why
       the stuck CAD 37.40 must be fixed by hand.

   CARRIED OVER FROM v3
     Explicit per-event maths, no double counting (ads were 2x in v2).
     by_settlement mode for complete financial data.
     Real dates everywhere. Currency codes on settlements.
     Hard error above 720 days instead of a fake $0.00.
   ================================================================== */

const COGS: Record<string, number> = {
	// $14.00 is the supplier's unverified all-in DDP claim. Honest air-freight
	// arithmetic at $6.78 FOB puts 50 units at $18.17, and US duty on copper
	// alone is roughly $3.60/unit. Correct this the moment an itemised
	// breakdown arrives.
	"AH-COPPER-1L": 14.0,
};

const MAX_FINANCE_DAYS = 720;

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

async function spRequest(method: string, path: string, body?: any): Promise<any> {
	const token = await getAccessToken();

	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(SP_HOST + path, {
			method,
			headers: {
				"x-amz-access-token": token,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (res.status === 429 || res.status >= 500) {
			await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
			continue;
		}

		const text = await res.text();
		if (!res.ok) throw new Error("SP-API " + res.status + ": " + text.slice(0, 400));
		return text ? JSON.parse(text) : {};
	}

	throw new Error("SP-API throttled after 4 attempts");
}

const spGet = (path: string) => spRequest("GET", path);
const spPost = (path: string, body: any) => spRequest("POST", path, body);

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

function amountOf(node: any): number {
	if (!node || typeof node !== "object") return 0;
	const v = node.CurrencyAmount ?? node.Amount ?? node.amount ?? node.currencyAmount ?? null;
	return v === null ? 0 : Number(v) || 0;
}

function currencyOf(node: any): string {
	if (!node || typeof node !== "object") return "";
	return node.CurrencyCode ?? node.currencyCode ?? "";
}

function sumFields(list: any[], fields: string[]): number {
	let t = 0;
	for (const item of list || []) {
		for (const f of fields) {
			if (item && item[f] !== undefined) t += amountOf(item[f]);
		}
	}
	return t;
}

function dateOf(node: any): string | null {
	if (!node || typeof node !== "object") return null;
	return node.PostedDate ?? node.postedDate ?? node.FundTransferDate ?? null;
}

function sumAllAmountsUnsafe(node: any, depth = 0): number {
	if (!node || depth > 14) return 0;
	if (Array.isArray(node)) return node.reduce((t, n) => t + sumAllAmountsUnsafe(n, depth + 1), 0);
	if (typeof node !== "object") return 0;
	const direct = amountOf(node);
	if (direct !== 0 && currencyOf(node)) return direct;
	let total = 0;
	for (const key of Object.keys(node)) {
		if (key === "PostedDate" || key === "postedDate") continue;
		total += sumAllAmountsUnsafe(node[key], depth + 1);
	}
	return total;
}

function prettify(key: string): string {
	return key
		.replace(/EventList$/, "")
		.replace(/List$/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/* ------------------------------------------------------------------ */
/*  REPORTS API — create, poll, download, decompress                   */
/* ------------------------------------------------------------------ */

/** Cloudflare Workers ship DecompressionStream, so GZIP needs no library. */
async function downloadReportDocument(documentId: string): Promise<string> {
	const doc = await spGet("/reports/2021-06-30/documents/" + encodeURIComponent(documentId));
	const res = await fetch(doc.url);
	if (!res.ok) throw new Error("Report download failed " + res.status);

	if (doc.compressionAlgorithm === "GZIP") {
		const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
		return await new Response(stream).text();
	}
	return await res.text();
}

/** Turns Amazon's tab-separated reports into objects. */
function parseTSV(text: string, limit = 500): any[] {
	const lines = text.split("\n").filter((l) => l.trim().length);
	if (!lines.length) return [];
	const headers = lines[0].split("\t").map((h) => h.trim());
	const rows: any[] = [];
	for (let i = 1; i < lines.length && rows.length < limit; i++) {
		const cells = lines[i].split("\t");
		const row: any = {};
		headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
		rows.push(row);
	}
	return rows;
}

/** Creates a report and waits for it, up to waitSeconds. */
async function createAndWait(
	reportType: string,
	days: number,
	reportOptions: any | undefined,
	waitSeconds: number
) {
	const body: any = {
		reportType,
		marketplaceIds: [MARKETPLACE_ID],
		dataStartTime: daysAgoISO(days),
		dataEndTime: new Date(Date.now() - 60000).toISOString(),
	};
	if (reportOptions) body.reportOptions = reportOptions;

	const created = await spPost("/reports/2021-06-30/reports", body);
	const reportId = created.reportId;

	const deadline = Date.now() + waitSeconds * 1000;
	let status = "IN_QUEUE";
	let documentId: string | null = null;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5000));
		const info = await spGet("/reports/2021-06-30/reports/" + encodeURIComponent(reportId));
		status = info.processingStatus;
		if (status === "DONE") {
			documentId = info.reportDocumentId;
			break;
		}
		if (status === "CANCELLED" || status === "FATAL") break;
	}

	return { reportId, status, documentId };
}

/* ------------------------------------------------------------------ */
/*  EXPLICIT EVENT HANDLERS — the double-counting fix (from v3)        */
/* ------------------------------------------------------------------ */

const EVENT_HANDLERS: Record<string, (e: any) => number> = {
	ShipmentEventList: (e) => {
		let t = 0;
		for (const item of e.ShipmentItemList || []) {
			t += sumFields(item.ItemChargeList, ["ChargeAmount"]);
			t += sumFields(item.ItemFeeList, ["FeeAmount"]);
			t += sumFields(item.PromotionList, ["PromotionAmount"]);
			t += sumFields(item.ItemTaxWithheldList, ["TaxesWithheld"]);
		}
		return t;
	},

	RefundEventList: (e) => {
		let t = 0;
		for (const item of e.ShipmentItemAdjustmentList || []) {
			t += sumFields(item.ItemChargeAdjustmentList, ["ChargeAmount"]);
			t += sumFields(item.ItemFeeAdjustmentList, ["FeeAmount"]);
			t += sumFields(item.PromotionAdjustmentList, ["PromotionAmount"]);
			t += sumFields(item.ItemTaxWithheldList, ["TaxesWithheld"]);
		}
		return t;
	},

	// transactionValue already contains baseValue + taxValue.
	// v2 added all three and reported roughly DOUBLE the real ad spend.
	ProductAdsPaymentEventList: (e) => {
		const total = e.transactionValue ?? e.TransactionValue;
		if (total !== undefined) return amountOf(total);
		return amountOf(e.baseValue ?? e.BaseValue) + amountOf(e.taxValue ?? e.TaxValue);
	},

	ServiceFeeEventList: (e) => sumFields(e.FeeList, ["FeeAmount"]),
	AdjustmentEventList: (e) => amountOf(e.AdjustmentAmount),
	DebtRecoveryEventList: (e) => amountOf(e.RecoveryAmount) + amountOf(e.OverPaymentCredit),

	RemovalShipmentEventList: (e) =>
		sumFields(e.RemovalShipmentItemList, ["Revenue", "FeeAmount", "TaxAmount", "TaxWithheld"]),

	RemovalShipmentAdjustmentEventList: (e) =>
		sumFields(e.RemovalShipmentItemAdjustmentList, [
			"RevenueAdjustment",
			"TaxAmountAdjustment",
			"TaxWithheldAdjustment",
		]),

	FBALiquidationEventList: (e) =>
		amountOf(e.LiquidationProceedsAmount) + amountOf(e.LiquidationFeeAmount),

	CouponPaymentEventList: (e) => amountOf(e.TotalAmount),
	SellerDealPaymentEventList: (e) => amountOf(e.totalAmount ?? e.TotalAmount),
	SAFETReimbursementEventList: (e) => amountOf(e.ReimbursedAmount),
	ImagingServicesFeeEventList: (e) => sumFields(e.FeeList, ["FeeAmount"]),
	AffordabilityExpenseEventList: (e) => amountOf(e.TotalExpense),
	AffordabilityExpenseReversalEventList: (e) => amountOf(e.TotalExpense),
	RetrochargeEventList: (e) => amountOf(e.BaseTax) + amountOf(e.ShippingTax),

	GuaranteeClaimEventList: (e) => {
		let t = 0;
		for (const item of e.ShipmentItemAdjustmentList || []) {
			t += sumFields(item.ItemChargeAdjustmentList, ["ChargeAmount"]);
			t += sumFields(item.ItemFeeAdjustmentList, ["FeeAmount"]);
		}
		return t;
	},

	ChargebackEventList: (e) => {
		let t = 0;
		for (const item of e.ShipmentItemAdjustmentList || []) {
			t += sumFields(item.ItemChargeAdjustmentList, ["ChargeAmount"]);
			t += sumFields(item.ItemFeeAdjustmentList, ["FeeAmount"]);
		}
		return t;
	},

	ServiceProviderCreditEventList: (e) => amountOf(e.TransactionAmount),
	PayWithAmazonEventList: (e) => amountOf(e.TransactionAmount),
	TrialShipmentEventList: (e) => sumFields(e.FeeList, ["FeeAmount"]),

	ShipmentSettleEventList: (e) => {
		let t = 0;
		for (const item of e.ShipmentItemList || []) {
			t += sumFields(item.ItemChargeList, ["ChargeAmount"]);
			t += sumFields(item.ItemFeeList, ["FeeAmount"]);
			t += sumFields(item.PromotionList, ["PromotionAmount"]);
		}
		return t;
	},

	RentalTransactionEventList: (e) =>
		sumFields(e.RentalChargeList, ["Amount"]) + sumFields(e.RentalFeeList, ["Amount"]),
};

/* ------------------------------------------------------------------ */
/*  FINANCIAL EVENT COLLECTION (from v3)                               */
/* ------------------------------------------------------------------ */

async function collectEventsByDate(days: number) {
	const base =
		"/finances/v0/financialEvents?PostedAfter=" +
		encodeURIComponent(daysAgoISO(days)) +
		"&MaxResultsPerPage=100";

	const groups: any[] = [];
	let nextToken: string | null = null;
	let pages = 0;
	let hitPageLimit = false;

	do {
		const path = nextToken
			? "/finances/v0/financialEvents?NextToken=" + encodeURIComponent(nextToken)
			: base;
		const data = await spGet(path);
		const payload = data?.payload || {};
		if (payload.FinancialEvents) groups.push(payload.FinancialEvents);
		nextToken = payload.NextToken || null;
		pages++;
		if (pages >= 40 && nextToken) {
			hitPageLimit = true;
			break;
		}
	} while (nextToken);

	return { groups, pages, hitPageLimit, settlementsRead: 0 };
}

async function collectEventsBySettlement(days: number) {
	const groupIds: string[] = [];
	let gToken: string | null = null;
	let gPages = 0;

	do {
		const path = gToken
			? "/finances/v0/financialEventGroups?NextToken=" + encodeURIComponent(gToken)
			: "/finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=" +
			  encodeURIComponent(daysAgoISO(days)) +
			  "&MaxResultsPerPage=100";
		const data = await spGet(path);
		const payload = data?.payload || {};
		for (const g of payload.FinancialEventGroupList || []) {
			if (g.FinancialEventGroupId) groupIds.push(g.FinancialEventGroupId);
		}
		gToken = payload.NextToken || null;
		gPages++;
	} while (gToken && gPages < 20);

	const groups: any[] = [];
	let pages = 0;
	let hitPageLimit = false;

	for (const id of groupIds) {
		let token: string | null = null;
		let inner = 0;
		do {
			const path = token
				? "/finances/v0/financialEventGroups/" +
				  encodeURIComponent(id) +
				  "/financialEvents?NextToken=" +
				  encodeURIComponent(token)
				: "/finances/v0/financialEventGroups/" +
				  encodeURIComponent(id) +
				  "/financialEvents?MaxResultsPerPage=100";
			try {
				const data = await spGet(path);
				const payload = data?.payload || {};
				if (payload.FinancialEvents) groups.push(payload.FinancialEvents);
				token = payload.NextToken || null;
			} catch {
				token = null;
			}
			inner++;
			pages++;
			if (inner >= 15) {
				hitPageLimit = true;
				break;
			}
		} while (token);
	}

	return { groups, pages, hitPageLimit, settlementsRead: groupIds.length };
}

/* ------------------------------------------------------------------ */
/*  SERVER                                                             */
/* ------------------------------------------------------------------ */

function createServer() {
	const server = new McpServer({
		name: "AH Inside Seller Central",
		version: "4.2.0",
	});

	/* ================= INVENTORY ================= */

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

				const items: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;
				let truncated = false;

				do {
					const path = nextToken ? base + "&nextToken=" + encodeURIComponent(nextToken) : base;
					const data = await spGet(path);
					const payload = data?.payload ?? data;
					items.push(...(payload?.inventorySummaries || []));
					nextToken = payload?.nextToken || null;
					pages++;
					if (pages >= 20 && nextToken) {
						truncated = true;
						break;
					}
				} while (nextToken);

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
						last_updated: s.lastUpdatedTime ?? null,
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
					pulled_at: new Date().toISOString(),
					sku_count: rows.length,
					totals,
					pages_read: pages,
					truncated,
					inventory: rows,
					note:
						"This feed can list SKUs that have no live listing. Cross-check against list_skus before acting on a difference.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= FINANCIALS ================= */

	server.registerTool(
		"get_financials",
		{
			description:
				"Complete financial picture for a period: revenue, referral and FBA fees, ADVERTISING SPEND, coupons, storage, subscription, refunds, removals and every other event type Amazon reports, with dates. Uses explicit per-event-type maths so totals are not double counted. Set by_settlement true for windows over 90 days. Default 30 days.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30. Maximum 720."),
				by_settlement: z
					.boolean()
					.optional()
					.describe(
						"Walk settlement groups instead of a date range. Slower, more API calls, but this is the only route Amazon documents as complete. Strongly recommended for any window over 90 days."
					),
			}),
		},
		async ({ days, by_settlement }: any) => {
			try {
				const window = Math.max(1, days ?? 30);

				if (window > MAX_FINANCE_DAYS) {
					return textResult({
						error: "WINDOW_TOO_LARGE",
						requested_days: window,
						max_days: MAX_FINANCE_DAYS,
						message:
							"Amazon's Finances API rejects a PostedAfter older than two years. Earlier versions reported that rejection as a real $0.00. Reduce the window.",
					});
				}

				const useSettlements = Boolean(by_settlement);
				const collected = useSettlements
					? await collectEventsBySettlement(window)
					: await collectEventsByDate(window);

				const { groups, pages, hitPageLimit, settlementsRead } = collected;

				const byList: Record<string, { events: number; usd: number; approximate: boolean }> = {};
				let earliest: string | null = null;
				let latest: string | null = null;

				const noteDate = (d: string | null) => {
					if (!d) return;
					if (!earliest || d < earliest) earliest = d;
					if (!latest || d > latest) latest = d;
				};

				for (const g of groups) {
					for (const key of Object.keys(g)) {
						const list = g[key];
						if (!Array.isArray(list) || list.length === 0) continue;
						const handler = EVENT_HANDLERS[key];
						if (!byList[key]) byList[key] = { events: 0, usd: 0, approximate: !handler };
						byList[key].events += list.length;
						for (const ev of list) {
							noteDate(dateOf(ev));
							byList[key].usd += handler ? handler(ev) : sumAllAmountsUnsafe(ev);
						}
					}
				}

				let revenue = 0;
				let itemFees = 0;
				let promotions = 0;
				let taxWithheld = 0;
				let units = 0;

				const perSku: Record<
					string,
					{
						units: number;
						revenue: number;
						fees: number;
						promos: number;
						refunds: number;
						refund_units: number;
						first_posted: string | null;
						last_posted: string | null;
					}
				> = {};

				const bucket = (sku: string) => {
					if (!perSku[sku])
						perSku[sku] = {
							units: 0,
							revenue: 0,
							fees: 0,
							promos: 0,
							refunds: 0,
							refund_units: 0,
							first_posted: null,
							last_posted: null,
						};
					return perSku[sku];
				};

				for (const g of groups) {
					for (const s of g.ShipmentEventList || []) {
						const posted = dateOf(s);
						for (const item of s.ShipmentItemList || []) {
							const sku = item.SellerSKU || "UNKNOWN";
							const b = bucket(sku);
							const qty = Number(item.QuantityShipped || 0);
							b.units += qty;
							units += qty;

							if (posted) {
								if (!b.first_posted || posted < b.first_posted) b.first_posted = posted;
								if (!b.last_posted || posted > b.last_posted) b.last_posted = posted;
							}

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
							for (const t of item.ItemTaxWithheldList || []) {
								taxWithheld += sumFields([t], ["TaxesWithheld"]);
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
				const removals =
					line("RemovalShipmentEventList") + line("RemovalShipmentAdjustmentEventList");

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
					"RemovalShipmentAdjustmentEventList",
				]);

				let otherTotal = 0;
				const otherLists: Record<string, string> = {};
				const approximateLists: string[] = [];

				for (const [k, v] of Object.entries(byList)) {
					if (v.approximate) approximateLists.push(prettify(k));
					if (namedKeys.has(k)) continue;
					otherTotal += v.usd;
					otherLists[prettify(k)] =
						money(v.usd) + " (" + v.events + " events)" + (v.approximate ? " ⚠ approximate" : "");
				}

				const totalCosts =
					itemFees + promotions + advertising + serviceFees + coupons + deals + refunds;

				const trueNet =
					revenue + totalCosts + adjustments + debtRecovery + liquidations + removals + otherTotal;

				const skuRows = Object.entries(perSku)
					.map(([sku, v]) => {
						const net = v.revenue + v.fees + v.promos + v.refunds;
						const cogs = COGS[sku];
						const row: any = {
							sku,
							units: v.units,
							// These are POSTED dates, not order dates. Amazon posts the
							// money roughly two weeks after the sale. Use
							// get_order_summary for the real sale date.
							first_posted: v.first_posted,
							last_posted: v.last_posted,
							revenue_usd: money(v.revenue),
							referral_and_fba_fees_usd: money(v.fees),
							promotions_usd: money(v.promos),
							refunds_usd: money(v.refunds),
							refund_units: v.refund_units,
							refund_rate_pct: v.units ? ((v.refund_units / v.units) * 100).toFixed(1) : "0.0",
							net_before_ads_and_storage_usd: money(net),
							net_per_unit_before_ads_and_storage_usd: v.units ? money(net / v.units) : "0.00",
						};
						if (cogs !== undefined && v.units) {
							row.cogs_usd = money(cogs * v.units);
							row.contribution_usd = money(net - cogs * v.units);
							row.contribution_per_unit_usd = money(net / v.units - cogs);
						}
						return row;
					})
					.sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd));

				const warnings: string[] = [];
				if (!useSettlements && window > 90) {
					warnings.push(
						"WINDOW OVER 90 DAYS WITHOUT by_settlement. Amazon does not guarantee that listFinancialEvents returns every event over a wide date range and gives no signal when it does not. Compare latest_event against today: if it stops short, the data is incomplete. Re-run with by_settlement: true."
					);
				}
				if (hitPageLimit) warnings.push("PAGE LIMIT HIT. Results incomplete. Narrow the window.");
				if (approximateLists.length) {
					warnings.push(
						"APPROXIMATE EVENT TYPES: " +
							approximateLists.join(", ") +
							". No explicit handler, so a generic walk was used which cannot tell a total from its own components. Add a handler in EVENT_HANDLERS before relying on them."
					);
				}

				return textResult({
					pulled_at: new Date().toISOString(),
					period_days: window,
					method: useSettlements ? "settlement_groups (complete)" : "posted_after (fast)",
					settlements_read: settlementsRead,
					pages_read: pages,
					truncated: hitPageLimit,
					earliest_event: earliest,
					latest_event: latest,
					warnings: warnings.length ? warnings : undefined,

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
						tax_withheld_usd: money(taxWithheld),
						total_selling_costs_usd: money(totalCosts),
						net_usd: money(trueNet),
					},

					event_counts: {
						shipments: count("ShipmentEventList"),
						refunds: count("RefundEventList"),
						service_fees: count("ServiceFeeEventList"),
						advertising: count("ProductAdsPaymentEventList"),
						coupons: count("CouponPaymentEventList"),
						removals: count("RemovalShipmentEventList"),
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
							{ events: v.events, usd: money(v.usd), ...(v.approximate ? { approximate: true } : {}) },
						])
					),

					notes: [
						"Dates here are POSTED dates, not order dates. Amazon posts money about two weeks after the sale. Use get_order_summary for real sale dates.",
						"Advertising uses transactionValue only. v2 added baseValue + taxValue + transactionValue and doubled it.",
						"per_sku net EXCLUDES advertising and storage — those are account-level. Only summary.net_usd is the bottom line.",
						"Landed cost is not available from Amazon. Contribution appears only for SKUs in the COGS constant.",
						"Clicks, CPC and ACOS require the Amazon Ads API. This is total spend only.",
					],
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= ORDERS ================= */

	server.registerTool(
		"get_order_summary",
		{
			description:
				"Order counts, units, gross revenue, status breakdown, month-by-month totals and the exact date of the most recent order. Optionally includes a per-SKU breakdown with each SKU's last sale date. Returns no buyer names or addresses. Default 30 days.",
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
					if (pages >= 30 && nextToken) {
						truncated = true;
						break;
					}
				} while (nextToken);

				orders.sort((a, b) =>
					String(b.PurchaseDate || "").localeCompare(String(a.PurchaseDate || ""))
				);

				const byStatus: Record<string, number> = {};
				const byChannel: Record<string, number> = {};
				const byMonth: Record<string, { orders: number; units: number; gross: number }> = {};
				let gross = 0;
				let units = 0;

				for (const o of orders) {
					byStatus[o.OrderStatus] = (byStatus[o.OrderStatus] || 0) + 1;
					const ch = o.FulfillmentChannel || "unknown";
					byChannel[ch] = (byChannel[ch] || 0) + 1;
					const total = amountOf(o.OrderTotal);
					const qty =
						Number(o.NumberOfItemsShipped || 0) + Number(o.NumberOfItemsUnshipped || 0);
					gross += total;
					units += qty;
					const month = String(o.PurchaseDate || "").slice(0, 7) || "unknown";
					if (!byMonth[month]) byMonth[month] = { orders: 0, units: 0, gross: 0 };
					byMonth[month].orders += 1;
					byMonth[month].units += qty;
					byMonth[month].gross += total;
				}

				const shipped = orders.filter((o) => o.OrderStatus === "Shipped");
				const lastOrder = orders[0];
				const lastShipped = shipped[0];

				const daysSince = (iso: string | undefined | null) =>
					iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

				const out: any = {
					pulled_at: new Date().toISOString(),
					period_days: window,
					pages_read: pages,
					truncated,
					order_count: orders.length,
					units,
					gross_usd: money(gross),
					average_order_value_usd: orders.length ? money(gross / orders.length) : "0.00",

					most_recent_order: lastOrder
						? {
								purchase_date: lastOrder.PurchaseDate,
								days_ago: daysSince(lastOrder.PurchaseDate),
								status: lastOrder.OrderStatus,
								order_total_usd: money(amountOf(lastOrder.OrderTotal)),
								channel: lastOrder.FulfillmentChannel,
						  }
						: null,

					most_recent_shipped_order: lastShipped
						? {
								purchase_date: lastShipped.PurchaseDate,
								days_ago: daysSince(lastShipped.PurchaseDate),
								order_total_usd: money(amountOf(lastShipped.OrderTotal)),
						  }
						: null,

					oldest_order_in_window: orders.length ? orders[orders.length - 1].PurchaseDate : null,
					by_status: byStatus,
					by_fulfillment_channel: byChannel,

					by_month: Object.fromEntries(
						Object.entries(byMonth)
							.sort((a, b) => b[0].localeCompare(a[0]))
							.map(([m, v]) => [m, { orders: v.orders, units: v.units, gross_usd: money(v.gross) }])
					),

					recent_orders: orders.slice(0, 20).map((o) => ({
						purchase_date: o.PurchaseDate,
						status: o.OrderStatus,
						total_usd: money(amountOf(o.OrderTotal)),
						items_shipped: Number(o.NumberOfItemsShipped || 0),
						channel: o.FulfillmentChannel,
					})),
				};

				if (include_skus) {
					const perSku: Record<
						string,
						{ units: number; revenue: number; orders: number; last_sale: string | null }
					> = {};
					const cap = Math.min(orders.length, 200);

					for (let i = 0; i < cap; i++) {
						const o = orders[i];
						try {
							const d = await spGet("/orders/v0/orders/" + o.AmazonOrderId + "/orderItems");
							for (const it of d?.payload?.OrderItems || []) {
								const sku = it.SellerSKU || "UNKNOWN";
								if (!perSku[sku]) perSku[sku] = { units: 0, revenue: 0, orders: 0, last_sale: null };
								perSku[sku].units += Number(it.QuantityOrdered || 0);
								perSku[sku].revenue += amountOf(it.ItemPrice);
								perSku[sku].orders += 1;
								const d0 = o.PurchaseDate;
								if (d0 && (!perSku[sku].last_sale || d0 > perSku[sku].last_sale!)) {
									perSku[sku].last_sale = d0;
								}
							}
						} catch {
							/* one bad order must not kill the report */
						}
					}

					out.per_sku = Object.entries(perSku)
						.map(([sku, v]) => ({
							sku,
							units: v.units,
							orders: v.orders,
							revenue_usd: money(v.revenue),
							last_sale: v.last_sale,
							days_since_last_sale: daysSince(v.last_sale),
						}))
						.sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd));

					out.per_sku_note =
						cap < orders.length
							? "Based on the most recent " + cap + " of " + orders.length + " orders."
							: "Covers all " + orders.length + " orders in the window.";
				}

				out.note =
					"units counts shipped plus unshipped and therefore includes cancelled orders. Compare against by_status before quoting it.";

				return textResult(out);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= SALES METRICS ================= */

	server.registerTool(
		"get_sales_metrics",
		{
			description:
				"Units ordered and revenue by day, week or month, straight from Amazon's Sales API. Faster than get_order_summary for trend shape and does not need per-order calls.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30."),
				granularity: z
					.string()
					.optional()
					.describe("Day, Week, Month, Year or Total. Default Day."),
			}),
		},
		async ({ days, granularity }: any) => {
			try {
				const window = Math.max(1, days ?? 30);
				const gran = granularity || "Day";
				const start = daysAgoISO(window);
				const end = new Date(Date.now() - 120000).toISOString();

				const data = await spGet(
					"/sales/v1/orderMetrics?marketplaceIds=" +
						MARKETPLACE_ID +
						"&interval=" +
						encodeURIComponent(start + "--" + end) +
						"&granularity=" +
						gran +
						"&granularityTimeZone=UTC"
				);

				const rows = (data?.payload || []).map((p: any) => ({
					interval: p.interval,
					units_ordered: p.unitCount,
					order_items: p.orderItemCount,
					orders: p.orderCount,
					revenue: money(amountOf(p.totalSales)),
					currency: currencyOf(p.totalSales) || "USD",
					average_unit_price: money(amountOf(p.averageUnitPrice)),
				}));

				const nonZero = rows.filter((r: any) => Number(r.units_ordered) > 0);

				return textResult({
					pulled_at: new Date().toISOString(),
					period_days: window,
					granularity: gran,
					intervals_returned: rows.length,
					intervals_with_sales: nonZero.length,
					total_units: rows.reduce((t: number, r: any) => t + Number(r.units_ordered || 0), 0),
					total_revenue: money(rows.reduce((t: number, r: any) => t + Number(r.revenue || 0), 0)),
					periods_with_sales: nonZero,
					note:
						"Only intervals with at least one unit are listed under periods_with_sales. Zero-sale days are counted but not printed.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= TRAFFIC AND CONVERSION ================= */

	server.registerTool(
		"get_traffic_and_conversion",
		{
			description:
				"THE MISSING NUMBER. Sessions, page views, Buy Box percentage and UNIT SESSION PERCENTAGE — your real conversion rate — per ASIN and per day, from Amazon's Sales and Traffic business report. Every plan that assumed 5% or 8.3% conversion can finally be checked against fact. Amazon builds this report asynchronously; if it is not ready inside the wait, a report_id comes back for get_report.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30. Maximum 730."),
				wait_seconds: z
					.number()
					.optional()
					.describe("How long to wait for Amazon to build it. Default 55."),
			}),
		},
		async ({ days, wait_seconds }: any) => {
			try {
				const window = Math.max(1, Math.min(days ?? 30, 730));
				const wait = Math.max(5, Math.min(wait_seconds ?? 55, 110));

				const { reportId, status, documentId } = await createAndWait(
					"GET_SALES_AND_TRAFFIC_REPORT",
					window,
					{ dateGranularity: "DAY", asinGranularity: "CHILD" },
					wait
				);

				if (status !== "DONE" || !documentId) {
					return textResult({
						report_id: reportId,
						status,
						message:
							"Amazon is still building this report. Call get_report with this report_id in a minute or two. Nothing is lost — the report keeps generating on Amazon's side.",
					});
				}

				const raw = await downloadReportDocument(documentId);
				const json = JSON.parse(raw);

				const byAsin = (json.salesAndTrafficByAsin || []).map((r: any) => {
					const t = r.trafficByAsin || {};
					const s = r.salesByAsin || {};
					return {
						date: r.startDate,
						asin: r.parentAsin || r.childAsin,
						child_asin: r.childAsin,
						sessions: t.sessions ?? 0,
						page_views: t.pageViews ?? 0,
						buy_box_pct: t.buyBoxPercentage ?? 0,
						units_ordered: s.unitsOrdered ?? 0,
						ordered_revenue: amountOf(s.orderedProductSales),
						// This is the conversion rate.
						unit_session_pct: t.unitSessionPercentage ?? 0,
					};
				});

				// Roll up per ASIN so the real CVR is a single number, not 30 rows.
				const roll: Record<string, { sessions: number; units: number; revenue: number; views: number }> = {};
				for (const r of byAsin) {
					const key = r.child_asin || r.asin || "UNKNOWN";
					if (!roll[key]) roll[key] = { sessions: 0, units: 0, revenue: 0, views: 0 };
					roll[key].sessions += Number(r.sessions || 0);
					roll[key].views += Number(r.page_views || 0);
					roll[key].units += Number(r.units_ordered || 0);
					roll[key].revenue += Number(r.ordered_revenue || 0);
				}

				const perAsin = Object.entries(roll)
					.map(([asin, v]) => ({
						asin,
						sessions: v.sessions,
						page_views: v.views,
						units_ordered: v.units,
						revenue_usd: money(v.revenue),
						conversion_rate_pct: v.sessions ? ((v.units / v.sessions) * 100).toFixed(2) : "0.00",
					}))
					.sort((a, b) => b.sessions - a.sessions);

				const totalSessions = perAsin.reduce((t, r) => t + r.sessions, 0);
				const totalUnits = perAsin.reduce((t, r) => t + r.units_ordered, 0);

				return textResult({
					pulled_at: new Date().toISOString(),
					period_days: window,
					report_id: reportId,
					rows_returned: byAsin.length,

					account_totals: {
						sessions: totalSessions,
						units_ordered: totalUnits,
						conversion_rate_pct: totalSessions
							? ((totalUnits / totalSessions) * 100).toFixed(2)
							: "0.00",
					},

					per_asin: perAsin,
					daily_rows: byAsin.slice(0, 200),

					notes: [
						"conversion_rate_pct is units ordered divided by sessions. This is the number every launch plan has been assuming rather than measuring.",
						"Buy Box percentage below 100 on a listing with no competitors usually means the listing was suppressed or out of stock for part of the day.",
						"Zero sessions with live inventory means nobody is finding the listing — that is a ranking problem, not a conversion problem.",
					],
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= GENERIC REPORTS ================= */

	server.registerTool(
		"run_report",
		{
			description:
				"Request any Amazon report and return it. Useful types: GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (why customers returned items — this is how to explain a high refund rate), GET_FBA_REIMBURSEMENTS_DATA (money Amazon owes for lost or damaged stock), GET_LEDGER_SUMMARY_VIEW_DATA (inventory movement), GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA (per-SKU fee estimates), GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT (real keyword impressions, clicks and purchases — Brand Registry only), GET_MERCHANT_LISTINGS_ALL_DATA. Returns a report_id if Amazon needs longer.",
			inputSchema: z.object({
				report_type: z.string().describe("The Amazon report type, exactly as spelled above."),
				days: z.number().optional().describe("Days to look back. Default 30."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 55."),
				max_rows: z.number().optional().describe("Rows to return. Default 200."),
			}),
		},
		async ({ report_type, days, wait_seconds, max_rows }: any) => {
			try {
				const window = Math.max(1, days ?? 30);
				const wait = Math.max(5, Math.min(wait_seconds ?? 55, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 200, 1000));

				const { reportId, status, documentId } = await createAndWait(
					report_type,
					window,
					undefined,
					wait
				);

				if (status !== "DONE" || !documentId) {
					return textResult({
						report_id: reportId,
						report_type,
						status,
						message:
							"Still building. Call get_report with this report_id shortly. FATAL usually means this account is not eligible for that report — Search Query Performance for example needs Brand Registry.",
					});
				}

				const raw = await downloadReportDocument(documentId);
				const trimmed = raw.trim();

				if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
					return textResult({
						pulled_at: new Date().toISOString(),
						report_type,
						report_id: reportId,
						format: "json",
						data: JSON.parse(trimmed),
					});
				}

				const rows = parseTSV(raw, limit);
				return textResult({
					pulled_at: new Date().toISOString(),
					report_type,
					report_id: reportId,
					format: "tsv",
					total_lines: raw.split("\n").filter((l) => l.trim()).length - 1,
					rows_returned: rows.length,
					columns: rows.length ? Object.keys(rows[0]) : [],
					rows,
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"get_report",
		{
			description:
				"Fetch a report that was requested earlier, using the report_id returned by run_report or get_traffic_and_conversion.",
			inputSchema: z.object({
				report_id: z.string().describe("The report_id from an earlier call."),
				max_rows: z.number().optional().describe("Rows to return. Default 200."),
			}),
		},
		async ({ report_id, max_rows }: any) => {
			try {
				const limit = Math.max(1, Math.min(max_rows ?? 200, 1000));
				const info = await spGet("/reports/2021-06-30/reports/" + encodeURIComponent(report_id));

				if (info.processingStatus !== "DONE") {
					return textResult({
						report_id,
						status: info.processingStatus,
						report_type: info.reportType,
						message:
							info.processingStatus === "FATAL"
								? "Amazon could not build this report. Usually an eligibility problem — Search Query Performance needs Brand Registry, and some reports need a longer date range."
								: "Not ready yet. Try again in a minute.",
					});
				}

				const raw = await downloadReportDocument(info.reportDocumentId);
				const trimmed = raw.trim();

				if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
					return textResult({
						pulled_at: new Date().toISOString(),
						report_id,
						report_type: info.reportType,
						format: "json",
						data: JSON.parse(trimmed),
					});
				}

				const rows = parseTSV(raw, limit);
				return textResult({
					pulled_at: new Date().toISOString(),
					report_id,
					report_type: info.reportType,
					format: "tsv",
					total_lines: raw.split("\n").filter((l) => l.trim()).length - 1,
					rows_returned: rows.length,
					columns: rows.length ? Object.keys(rows[0]) : [],
					rows,
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= PRICING ================= */

	server.registerTool(
		"get_competitive_pricing",
		{
			description:
				"Buy Box owner, lowest offer, offer count and condition breakdown for one or more ASINs. Works on competitor ASINs too, so it can check what a rival is charging today without opening Amazon.",
			inputSchema: z.object({
				asins: z.string().describe("One ASIN, or several separated by commas. Maximum 20."),
			}),
		},
		async ({ asins }: any) => {
			try {
				const list = String(asins)
					.split(",")
					.map((a) => a.trim())
					.filter(Boolean)
					.slice(0, 20);

				const data = await spGet(
					"/products/pricing/v0/competitivePrice?MarketplaceId=" +
						MARKETPLACE_ID +
						"&Asins=" +
						encodeURIComponent(list.join(",")) +
						"&ItemType=Asin"
				);

				const rows = (data?.payload || []).map((p: any) => {
					const product = p.Product || {};
					const comp = product.CompetitivePricing || {};
					const prices = (comp.CompetitivePrices || []).map((c: any) => ({
						condition: c.condition,
						belongs_to_requester: c.belongsToRequester,
						landed_price: money(amountOf(c.Price?.LandedPrice)),
						listing_price: money(amountOf(c.Price?.ListingPrice)),
						shipping: money(amountOf(c.Price?.Shipping)),
					}));
					const counts = (comp.NumberOfOfferListings || []).map((n: any) => ({
						condition: n.condition,
						count: n.Count,
					}));
					return {
						asin: p.ASIN,
						status: p.status,
						competitive_prices: prices,
						offer_counts: counts,
						sales_rankings: (product.SalesRankings || []).slice(0, 3),
					};
				});

				return textResult({
					pulled_at: new Date().toISOString(),
					asins_requested: list,
					results: rows,
					note:
						"belongs_to_requester true means that price is your own offer. A missing Buy Box price usually means no offer currently holds it.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= FEE ESTIMATE ================= */

	server.registerTool(
		"estimate_fees",
		{
			description:
				"Referral and FBA fees for any ASIN at any price, before you ever list it. This is the Gate 2 check without guessing: run it on a comparable copper bottle ASIN at 49.95 to see the real fee, and re-run it whenever the kit box dimensions change.",
			inputSchema: z.object({
				asin: z.string().describe("The ASIN to price against — a competitor's is fine."),
				price: z.number().describe("Selling price in USD, for example 49.95."),
				shipping: z.number().optional().describe("Shipping charged to the buyer. Default 0."),
				fba: z.boolean().optional().describe("Fulfilled by Amazon. Default true."),
			}),
		},
		async ({ asin, price, shipping, fba }: any) => {
			try {
				const body = {
					FeesEstimateRequest: {
						MarketplaceId: MARKETPLACE_ID,
						IsAmazonFulfilled: fba !== false,
						PriceToEstimateFees: {
							ListingPrice: { CurrencyCode: "USD", Amount: price },
							Shipping: { CurrencyCode: "USD", Amount: shipping ?? 0 },
						},
						Identifier: "ah-" + Date.now(),
					},
				};

				const data = await spPost(
					"/products/fees/v0/items/" + encodeURIComponent(asin) + "/feesEstimate",
					body
				);

				const result = data?.payload?.FeesEstimateResult || data?.FeesEstimateResult || {};
				const est = result.FeesEstimate || {};
				const details = (est.FeeDetailList || []).map((f: any) => ({
					type: f.FeeType,
					amount_usd: money(amountOf(f.FeeAmount)),
					promotion_usd: money(amountOf(f.FeePromotion)),
					final_usd: money(amountOf(f.FinalFee)),
				}));

				const totalFees = amountOf(est.TotalFeesEstimate);
				const net = price + (shipping ?? 0) - totalFees;

				return textResult({
					pulled_at: new Date().toISOString(),
					asin,
					price_usd: money(price),
					status: result.Status,
					error: result.Error?.Message,
					total_fees_usd: money(totalFees),
					fee_percentage: price ? ((totalFees / price) * 100).toFixed(1) + "%" : "0.0%",
					net_before_cogs_usd: money(net),
					fee_breakdown: details,
					note:
						"Gate 2 wants fees under roughly 12-15% of price. This figure uses the dimensions of the ASIN you passed, so run it against a bottle of the same size as the finished kit box, not the bare bottle.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= INBOUND SHIPMENTS ================= */

	server.registerTool(
		"get_inbound_shipments",
		{
			description:
				"FBA inbound shipments and their status — what is on the way to Amazon, what has been received, and what is stuck. Use this to track the 50 copper bottles once they ship.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 180."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.max(1, days ?? 180);
				const data = await spGet(
					"/fba/inbound/v0/shipments?QueryType=DATE_RANGE&MarketplaceId=" +
						MARKETPLACE_ID +
						"&LastUpdatedAfter=" +
						encodeURIComponent(daysAgoISO(window))
				);

				const shipments = (data?.payload?.ShipmentData || []).map((s: any) => ({
					shipment_id: s.ShipmentId,
					name: s.ShipmentName,
					status: s.ShipmentStatus,
					destination: s.DestinationFulfillmentCenterId,
					units_shipped: s.BoxContentsSource,
					are_cases_required: s.AreCasesRequired,
					label_prep: s.LabelPrepType,
				}));

				return textResult({
					pulled_at: new Date().toISOString(),
					period_days: window,
					shipment_count: shipments.length,
					by_status: shipments.reduce((t: any, s: any) => {
						t[s.status] = (t[s.status] || 0) + 1;
						return t;
					}, {}),
					shipments,
					note:
						"WORKING means created but not sent. SHIPPED means in transit. RECEIVING means Amazon is checking it in. CLOSED means done. Anything sitting in RECEIVING for over a week needs a case opened.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= LISTINGS ================= */

	server.registerTool(
		"list_skus",
		{
			description:
				"Every SKU on the account with its ASIN, title, status, buyability and any listing issues, including whether an issue suppresses the listing.",
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
					const path = nextToken ? base + "&pageToken=" + encodeURIComponent(nextToken) : base;
					const data = await spGet(path);
					items.push(...(data?.items || []));
					nextToken = data?.pagination?.nextToken || null;
					pages++;
				} while (nextToken && pages < 20);

				const rows = items.map((i: any) => {
					const s = (i.summaries || [])[0] || {};
					const issues = i.issues || [];
					const status: string[] = s.status || [];
					const enforcements = issues.flatMap((x: any) =>
						(x.enforcements?.actions || []).map((a: any) => a.action)
					);
					return {
						sku: i.sku,
						asin: s.asin,
						title: s.itemName,
						status: status.join(", "),
						buyable: status.includes("BUYABLE"),
						suppressed: enforcements.includes("LISTING_SUPPRESSED"),
						condition: s.conditionType ?? null,
						created: s.createdDate,
						last_updated: s.lastUpdatedDate,
						issue_count: issues.length,
						issues: issues.map((x: any) => x.code + " (" + x.severity + "): " + x.message).slice(0, 5),
						enforcements,
					};
				});

				return textResult({
					pulled_at: new Date().toISOString(),
					sku_count: rows.length,
					buyable_count: rows.filter((r) => r.buyable).length,
					suppressed_count: rows.filter((r) => r.suppressed).length,
					skus: rows,
					note:
						"DISCOVERABLE without BUYABLE means the detail page exists but nothing can be bought. Normal at zero inventory, and also what a suppressed listing looks like — check the suppressed flag to tell them apart.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"get_listing",
		{
			description:
				"Full listing detail for one SKU: attributes, bullet points, status, offers, offer start and end dates, fulfilment availability and listing issues. Use list_skus first if the exact SKU string is unknown.",
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

				const s = (data?.summaries || [])[0] || {};
				const po = (data?.attributes?.purchasable_offer || [])[0] || {};
				const flags = {
					status: (s.status || []).join(", "),
					buyable: (s.status || []).includes("BUYABLE"),
					offer_starts: po?.start_at?.value ?? null,
					offer_ends: po?.end_at?.value ?? null,
					offer_ended: po?.end_at?.value ? new Date(po.end_at.value).getTime() < Date.now() : false,
					parentage: data?.attributes?.parentage_level?.[0]?.value ?? null,
					suppressed: (data?.issues || []).some((x: any) =>
						(x.enforcements?.actions || []).some((a: any) => a.action === "LISTING_SUPPRESSED")
					),
				};

				return textResult({ pulled_at: new Date().toISOString(), key_flags: flags, ...data });
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= SETTLEMENTS ================= */

	server.registerTool(
		"get_settlements",
		{
			description:
				"Settlement periods and payout balances — when Amazon paid out, how much, in which currency, and which transfers FAILED. Follows pagination and flags consecutive failures.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 90."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.max(1, days ?? 90);
				const raw: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;
				let truncated = false;

				do {
					const path = nextToken
						? "/finances/v0/financialEventGroups?NextToken=" + encodeURIComponent(nextToken)
						: "/finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=" +
						  encodeURIComponent(daysAgoISO(window)) +
						  "&MaxResultsPerPage=100";
					const data = await spGet(path);
					const payload = data?.payload || {};
					raw.push(...(payload.FinancialEventGroupList || []));
					nextToken = payload.NextToken || null;
					pages++;
					if (pages >= 20 && nextToken) {
						truncated = true;
						break;
					}
				} while (nextToken);

				const groups = raw.map((g: any) => ({
					group_id: g.FinancialEventGroupId,
					status: g.ProcessingStatus,
					started: g.FinancialEventGroupStart,
					ended: g.FinancialEventGroupEnd,
					fund_transfer_status: g.FundTransferStatus,
					original_total: money(amountOf(g.OriginalTotal)),
					original_currency: currencyOf(g.OriginalTotal) || "USD",
					converted_total: money(amountOf(g.ConvertedTotal)),
					disbursement_currency: currencyOf(g.ConvertedTotal) || "unknown",
					beginning_balance: money(amountOf(g.BeginningBalance)),
					beginning_balance_currency: currencyOf(g.BeginningBalance) || "USD",
					fund_transfer_date: g.FundTransferDate,
					trace_id: g.TraceId,
				}));

				groups.sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));

				const failed = groups.filter((g) => g.fund_transfer_status === "Failed");
				const succeeded = groups.filter((g) => g.fund_transfer_status === "Succeeded");

				const stuck: Record<string, number> = {};
				for (const g of failed) {
					const bal = Number(g.beginning_balance);
					if (bal > 0) {
						const key = g.beginning_balance + " " + g.beginning_balance_currency;
						stuck[key] = (stuck[key] || 0) + 1;
					}
				}

				const openGroups = groups.filter((g) => g.status === "Open");

				return textResult({
					pulled_at: new Date().toISOString(),
					period_days: window,
					pages_read: pages,
					truncated,
					count: groups.length,

					health: {
						succeeded_transfers: succeeded.length,
						failed_transfers: failed.length,
						open_periods: openGroups.length,
						open_balances: openGroups.map((g) => ({
							started: g.started,
							balance: g.beginning_balance + " " + g.beginning_balance_currency,
						})),
						repeated_stuck_balances: Object.entries(stuck)
							.filter(([, n]) => n >= 3)
							.map(([bal, n]) => bal + " held across " + n + " failed periods"),
						last_successful_transfer: succeeded[0]
							? {
									date: succeeded[0].fund_transfer_date,
									amount: succeeded[0].converted_total + " " + succeeded[0].disbursement_currency,
							  }
							: null,
					},

					settlements: groups,

					note:
						"Check the CURRENCY on a stuck balance before assuming a bank fault. A balance in a currency you do not sell in belongs to a marketplace with no deposit method attached, which Amazon will retry forever. Seller Central → Payments → Deposit Methods.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= PROXY TEST (new in v4.1) ================= */

	server.registerTool(
		"proxy_test",
		{
			description:
				"Stage 1 test of the DataImpulse residential proxy. Fetches ip-api.com over a raw TCP socket through gw.dataimpulse.com:823 using plain HTTP, so no TLS can confuse the result. A US residential IP means the proxy route works. An empty response means raw sockets are blocked and Cloudflare Browser Run is the fallback. Requires the PROXY_USER and PROXY_PASS secrets.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				if (!currentEnv.PROXY_USER || !currentEnv.PROXY_PASS) {
					return textResult({
						error: "MISSING_SECRETS",
						message:
							"PROXY_USER and PROXY_PASS are not set. Cloudflare dashboard → Workers & Pages → remote-mcp-server-authless → Settings → Variables and Secrets → Add, type Secret.",
					});
				}

				const started = Date.now();
				const auth = btoa(currentEnv.PROXY_USER + ":" + currentEnv.PROXY_PASS);

				const socket = connect({ hostname: "gw.dataimpulse.com", port: 823 });

				const request =
					"GET http://ip-api.com/json HTTP/1.1\r\n" +
					"Host: ip-api.com\r\n" +
					"Proxy-Authorization: Basic " +
					auth +
					"\r\n" +
					"User-Agent: Mozilla/5.0\r\n" +
					"Accept: */*\r\n" +
					"Connection: close\r\n" +
					"\r\n";

				const writer = socket.writable.getWriter();
				await writer.write(new TextEncoder().encode(request));
				writer.releaseLock();

				const reader = socket.readable.getReader();
				const chunks: Uint8Array[] = [];
				let bytes = 0;

				while (bytes < 20000) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						chunks.push(value);
						bytes += value.length;
					}
				}

				reader.releaseLock();
				try {
					await socket.close();
				} catch {
					/* the proxy usually closes first; that is not an error */
				}

				const decoder = new TextDecoder();
				let raw = "";
				for (const c of chunks) raw += decoder.decode(c, { stream: true });
				raw += decoder.decode();

				if (!raw) {
					return textResult({
						result: "EMPTY_RESPONSE",
						elapsed_ms: Date.now() - started,
						message:
							"The socket opened but returned nothing. This is the known Workers startTls / raw-socket failure. Fall back to Cloudflare Browser Run.",
					});
				}

				const split = raw.indexOf("\r\n\r\n");
				const headers = split >= 0 ? raw.slice(0, split) : raw;
				const body = split >= 0 ? raw.slice(split + 4) : "";
				const statusLine = headers.split("\r\n")[0] || "";

				let exitIp: string | null = null;
				let country: string | null = null;
				let isp: string | null = null;

				const jsonStart = body.indexOf("{");
				const jsonEnd = body.lastIndexOf("}");
				if (jsonStart >= 0 && jsonEnd > jsonStart) {
					try {
						const parsed = JSON.parse(body.slice(jsonStart, jsonEnd + 1));
						exitIp = parsed.query ?? null;
						country = parsed.country ?? null;
						isp = parsed.isp ?? null;
					} catch {
						/* chunked encoding can break a clean parse; raw_body still shows it */
					}
				}

				return textResult({
					result: exitIp ? "PROXY_WORKING" : "RESPONSE_RECEIVED_BUT_NOT_PARSED",
					elapsed_ms: Date.now() - started,
					status_line: statusLine,
					exit_ip: exitIp,
					country,
					isp,
					bytes_received: bytes,
					raw_body: body.slice(0, 1200),
					next_step: exitIp
						? "Proxy route confirmed. Stage 2 is CONNECT + startTls to amazon.com."
						: "Read status_line. A 407 means the login or password is wrong. Anything else, read raw_body.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================= AMAZON TEST (new in v4.2) ================= */

	server.registerTool(
		"amazon_test",
		{
			description:
				"Stage 2 test. Opens a raw socket to the DataImpulse proxy, sends HTTP CONNECT for www.amazon.com:443, upgrades the socket with startTls, and requests a real Amazon search page over HTTPS. Reports the exit country, the HTTP status, whether a captcha was served, and how many product tiles were found. This is the test that decides whether the whole scraper approach works.",
			inputSchema: z.object({
				keyword: z
					.string()
					.optional()
					.describe("Search phrase. Default 'copper water bottle'."),
			}),
		},
		async ({ keyword }: any) => {
			const started = Date.now();
			try {
				if (!currentEnv.PROXY_USER || !currentEnv.PROXY_PASS) {
					return textResult({
						error: "MISSING_SECRETS",
						message: "PROXY_USER and PROXY_PASS are not set in Cloudflare.",
					});
				}

				const term = (keyword || "copper water bottle").trim();
				const path = "/s?k=" + encodeURIComponent(term);
				const auth = btoa(currentEnv.PROXY_USER + ":" + currentEnv.PROXY_PASS);

				// Step 1 — plain socket to the proxy, prepared for a later TLS upgrade.
				const socket = connect(
					{ hostname: "gw.dataimpulse.com", port: 823 },
					{ secureTransport: "starttls", allowHalfOpen: false }
				);

				const enc = new TextEncoder();
				const dec = new TextDecoder();

				let writer = socket.writable.getWriter();
				let reader = socket.readable.getReader();

				// Step 2 — ask the proxy to tunnel to Amazon on 443.
				const connectRequest =
					"CONNECT www.amazon.com:443 HTTP/1.1\r\n" +
					"Host: www.amazon.com:443\r\n" +
					"Proxy-Authorization: Basic " +
					auth +
					"\r\n" +
					"Proxy-Connection: Keep-Alive\r\n" +
					"\r\n";

				await writer.write(enc.encode(connectRequest));

				let head = "";
				while (!head.includes("\r\n\r\n")) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) head += dec.decode(value, { stream: true });
					if (head.length > 8000) break;
				}

				const connectStatus = (head.split("\r\n")[0] || "").trim();

				if (!/^HTTP\/1\.[01] 200/.test(connectStatus)) {
					try {
						reader.releaseLock();
						writer.releaseLock();
						await socket.close();
					} catch {
						/* ignore */
					}
					return textResult({
						result: "CONNECT_REFUSED",
						stage: "proxy CONNECT",
						elapsed_ms: Date.now() - started,
						connect_status: connectStatus || "(nothing returned)",
						raw_head: head.slice(0, 400),
						message:
							"The proxy would not open a tunnel to port 443. A 407 here means credentials; anything else is a proxy-side refusal.",
					});
				}

				// Step 3 — upgrade the same socket to TLS.
				reader.releaseLock();
				writer.releaseLock();

				const tls = socket.startTls();
				writer = tls.writable.getWriter();
				reader = tls.readable.getReader();

				// Step 4 — a normal browser request, inside the tunnel.
				const request =
					"GET " +
					path +
					" HTTP/1.1\r\n" +
					"Host: www.amazon.com\r\n" +
					"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n" +
					"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n" +
					"Accept-Language: en-US,en;q=0.9\r\n" +
					"Accept-Encoding: identity\r\n" +
					"Upgrade-Insecure-Requests: 1\r\n" +
					"Connection: close\r\n" +
					"\r\n";

				await writer.write(enc.encode(request));

				let raw = "";
				let bytes = 0;
				const CAP = 90000;

				while (bytes < CAP) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						bytes += value.length;
						raw += dec.decode(value, { stream: true });
					}
				}
				raw += dec.decode();

				try {
					reader.releaseLock();
					await tls.close();
				} catch {
					/* the far side normally closes first */
				}

				if (!raw) {
					return textResult({
						result: "EMPTY_AFTER_TLS",
						stage: "startTls",
						elapsed_ms: Date.now() - started,
						connect_status: connectStatus,
						message:
							"The tunnel opened but the TLS socket returned nothing. This is the known Cloudflare startTls production failure. Fall back to Browser Run.",
					});
				}

				const split = raw.indexOf("\r\n\r\n");
				const headers = split >= 0 ? raw.slice(0, split) : raw;
				const body = split >= 0 ? raw.slice(split + 4) : "";
				const statusLine = (headers.split("\r\n")[0] || "").trim();

				const lower = body.toLowerCase();
				const captcha =
					lower.includes("api-services-support@amazon.com") ||
					lower.includes("enter the characters you see below") ||
					lower.includes("/errors/validatecaptcha") ||
					lower.includes("robot check");

				const asinMatches = body.match(/data-asin="[A-Z0-9]{10}"/g) || [];
				const uniqueAsins = Array.from(
					new Set(asinMatches.map((m) => m.slice(11, 21)))
				);

				const titleMatch = headers.match(/^HTTP\/1\.[01] (\d{3})/);
				const httpCode = titleMatch ? Number(titleMatch[1]) : 0;

				let verdict = "UNKNOWN";
				if (captcha) verdict = "CAPTCHA_SERVED";
				else if (httpCode === 200 && uniqueAsins.length >= 5) verdict = "SCRAPE_WORKING";
				else if (httpCode === 200) verdict = "PAGE_RETURNED_BUT_NO_PRODUCTS";
				else if (httpCode === 503) verdict = "AMAZON_THROTTLED";
				else if (httpCode >= 300 && httpCode < 400) verdict = "REDIRECTED";

				return textResult({
					result: verdict,
					elapsed_ms: Date.now() - started,
					keyword: term,
					connect_status: connectStatus,
					http_status: statusLine,
					bytes_received: bytes,
					captcha_detected: captcha,
					unique_asins_found: uniqueAsins.length,
					first_asins: uniqueAsins.slice(0, 10),
					body_preview: body.slice(0, 600),
					next_step:
						verdict === "SCRAPE_WORKING"
							? "Everything works. Build search_amazon and get_product on this exact pattern."
							: verdict === "CAPTCHA_SERVED"
							? "Amazon served a captcha, most likely a datacentre exit IP. Retry a few times; if it persists, add a sticky-session or ISP filter to PROXY_USER."
							: "Read http_status and body_preview before changing anything.",
				});
			} catch (e: any) {
				return textResult({
					result: "EXCEPTION",
					elapsed_ms: Date.now() - started,
					message: e?.message || String(e),
					note:
						"An exception at the startTls step is the documented Workers limitation. Anything else is ordinary and fixable.",
				});
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

		if (!gate || !url.pathname.startsWith("/" + gate)) {
			return new Response("Not found", { status: 404 });
		}

		const inner = url.pathname.slice(gate.length + 1) || "/";
		const rewritten = new URL(request.url);
		rewritten.pathname = inner;

		return handler(new Request(rewritten.toString(), request), env, ctx);
	},
};
