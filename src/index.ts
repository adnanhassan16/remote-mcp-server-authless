import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const SP_HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SELLER_ID = "A2ZPQEA709W727";

/* ==================================================================
   v3.0 — 5 September 2026

   WHAT WAS WRONG IN v2 AND IS FIXED HERE

   1. DOUBLE COUNTING. sumAllAmounts() walked every currency field in
      every event. Several Amazon event types carry BOTH a total AND
      the components that make up that total. Advertising is the worst
      case: ProductAdsPaymentEvent has baseValue, taxValue AND
      transactionValue, where transactionValue = baseValue + taxValue.
      The blind walk added all three and reported roughly DOUBLE the
      real spend. That is why 365 days showed $3,616.80 against a
      lifetime CSV figure of $2,009.55.
      Same fault applied to CouponPaymentEvent (TotalAmount + its own
      Fee and Charge components), SellerDealPaymentEvent, AdjustmentEvent
      and DebtRecoveryEvent.
      FIX: explicit per-event-type handlers below. The generic walk is
      now a LAST RESORT for event types Amazon adds later, and anything
      it touches is flagged approximate: true in the output.

   2. NO DATES. Nothing returned a posted or purchase date, so finding
      the last sale needed seven separate calls narrowing the window by
      hand. Every tool now returns real dates.

   3. UNRELIABLE LONG WINDOWS. Amazon's own documentation warns that
      listFinancialEvents with PostedAfter can return incomplete results
      over wide date ranges, and the API returns NextToken = null anyway
      so nothing detects it. That is why 430 days returned FEWER events
      than 365 days and dropped the Wooden Tong SKU entirely.
      FIX: by_settlement mode walks financialEventGroups and pulls
      events per group, which is the route Amazon documents as complete.
      Auto-warns whenever days > 90 and by_settlement is off.

   4. MISLABELLED CURRENCY. converted_total_usd was never USD. It is the
      disbursement currency, GBP for this account, at roughly 0.728.
      Now reported with its real currency code.

   5. get_settlements DID NOT PAGINATE. One call, 100 groups max. Fine
      at 63 groups today, silently wrong later.

   6. PER-SKU NET EXCLUDED ADS AND STORAGE. net_after_amazon_usd only
      subtracted referral, FBA, promos and refunds, so every per-unit
      figure read better than reality. Now labelled explicitly and a
      true account-level net is reported alongside it.
   ================================================================== */

// Landed cost per unit in USD. Amazon never knows what you paid the supplier,
// so contribution margin is only as honest as what is typed here.
const COGS: Record<string, number> = {
	// Copper bottle. $14.00 is the supplier's all-in DDP claim and is NOT yet
	// verified. Honest arithmetic at $6.78 FOB puts 50 units by air at $18.17,
	// and US duty on copper alone is roughly $3.60/unit. If the real figure is
	// $18.17, every contribution number below is overstated by $4.17 a unit.
	// Correct this the moment the supplier sends an itemised breakdown.
	"AH-COPPER-1L": 14.0,
};

// Amazon's Finances API rejects a PostedAfter older than two years.
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
		node.CurrencyAmount ?? node.Amount ?? node.amount ?? node.currencyAmount ?? null;
	return v === null ? 0 : Number(v) || 0;
}

/** Currency code out of any of the shapes Amazon uses. */
function currencyOf(node: any): string {
	if (!node || typeof node !== "object") return "";
	return node.CurrencyCode ?? node.currencyCode ?? "";
}

/** Sums a list of {SomethingAmount} objects under the given field names. */
function sumFields(list: any[], fields: string[]): number {
	let t = 0;
	for (const item of list || []) {
		for (const f of fields) {
			if (item && item[f] !== undefined) t += amountOf(item[f]);
		}
	}
	return t;
}

/** Posted date out of any of the shapes Amazon uses. */
function dateOf(node: any): string | null {
	if (!node || typeof node !== "object") return null;
	return node.PostedDate ?? node.postedDate ?? node.FundTransferDate ?? null;
}

/**
 * LAST RESORT ONLY. Used for event types this file does not know about,
 * so a new Amazon event type is still visible rather than silently dropped.
 * Anything summed this way is reported with approximate: true, because a
 * blind walk cannot tell a total apart from the components of that total.
 */
function sumAllAmountsUnsafe(node: any, depth = 0): number {
	if (!node || depth > 14) return 0;

	if (Array.isArray(node)) {
		return node.reduce((t, n) => t + sumAllAmountsUnsafe(n, depth + 1), 0);
	}

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

/** Human-readable label for an event list key. */
function prettify(key: string): string {
	return key
		.replace(/EventList$/, "")
		.replace(/List$/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/* ------------------------------------------------------------------ */
/*  EXPLICIT EVENT HANDLERS — the double-counting fix                  */
/*                                                                     */
/*  Each returns the NET value of one event. Where Amazon supplies a    */
/*  total AND its components, only the total is taken.                 */
/* ------------------------------------------------------------------ */

const EVENT_HANDLERS: Record<string, (e: any) => number> = {
	// Sales. No grand total is supplied, so components are summed.
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

	// ⚠️ THE BIG ONE. transactionValue already contains baseValue + taxValue.
	// v2 added all three and roughly doubled every advertising figure.
	ProductAdsPaymentEventList: (e) => {
		const total = e.transactionValue ?? e.TransactionValue;
		if (total !== undefined) return amountOf(total);
		// Fallback only if Amazon omits the total.
		return amountOf(e.baseValue ?? e.BaseValue) + amountOf(e.taxValue ?? e.TaxValue);
	},

	// Storage, subscription, long-term storage, removals, Vine. Components only.
	ServiceFeeEventList: (e) => sumFields(e.FeeList, ["FeeAmount"]),

	// AdjustmentAmount is the total of AdjustmentItemList. Take the total only.
	AdjustmentEventList: (e) => amountOf(e.AdjustmentAmount),

	// RecoveryAmount is the total of DebtRecoveryItemList. Total only.
	DebtRecoveryEventList: (e) =>
		amountOf(e.RecoveryAmount) + amountOf(e.OverPaymentCredit),

	// Liquidation and removal income. No grand total supplied.
	RemovalShipmentEventList: (e) =>
		sumFields(e.RemovalShipmentItemList, [
			"Revenue",
			"FeeAmount",
			"TaxAmount",
			"TaxWithheld",
		]),

	RemovalShipmentAdjustmentEventList: (e) =>
		sumFields(e.RemovalShipmentItemAdjustmentList, [
			"RevenueAdjustment",
			"TaxAmountAdjustment",
			"TaxWithheldAdjustment",
		]),

	FBALiquidationEventList: (e) =>
		amountOf(e.LiquidationProceedsAmount) + amountOf(e.LiquidationFeeAmount),

	// TotalAmount already contains FeeComponent + ChargeComponent.
	CouponPaymentEventList: (e) => amountOf(e.TotalAmount),

	// totalAmount already contains feeAmount + taxAmount.
	SellerDealPaymentEventList: (e) =>
		amountOf(e.totalAmount ?? e.TotalAmount),

	SAFETReimbursementEventList: (e) => amountOf(e.ReimbursedAmount),

	ImagingServicesFeeEventList: (e) => sumFields(e.FeeList, ["FeeAmount"]),

	// TotalExpense already contains BaseExpense plus the tax components.
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
/*  FINANCIAL EVENT COLLECTION                                         */
/* ------------------------------------------------------------------ */

/** Pulls FinancialEvents blocks using PostedAfter. Fast, but Amazon does not
 *  guarantee completeness over wide windows. */
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

/** Walks every settlement group in the window and pulls that group's events.
 *  Slower and more calls, but this is the route Amazon documents as complete. */
async function collectEventsBySettlement(days: number) {
	// 1. list the settlement groups
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

	// 2. pull each group's events
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
				// One unreadable settlement must not kill the whole report.
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
		version: "3.0.0",
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

				const items: any[] = [];
				let nextToken: string | null = null;
				let pages = 0;
				let truncated = false;

				do {
					const path = nextToken
						? base + "&nextToken=" + encodeURIComponent(nextToken)
						: base;
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

	/* ---------------- FINANCIALS ---------------- */

	server.registerTool(
		"get_financials",
		{
			description:
				"Complete financial picture for a period: revenue, referral and FBA fees, ADVERTISING SPEND, coupons, storage, subscription, refunds, removals and every other event type Amazon reports, with dates. Uses explicit per-event-type maths so totals are not double counted. Set by_settlement true for windows over 90 days. Default 30 days.",
			inputSchema: z.object({
				days: z
					.number()
					.optional()
					.describe("Days to look back. Default 30. Maximum 720."),
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
							"Amazon's Finances API rejects a PostedAfter older than two years. Earlier versions of this tool reported that rejection as a real $0.00. Reduce the window to " +
							MAX_FINANCE_DAYS +
							" days or fewer.",
					});
				}

				const useSettlements = Boolean(by_settlement);
				const collected = useSettlements
					? await collectEventsBySettlement(window)
					: await collectEventsByDate(window);

				const { groups, pages, hitPageLimit, settlementsRead } = collected;

				/* --- every event list, counted with the correct maths --- */

				const byList: Record<
					string,
					{ events: number; usd: number; approximate: boolean }
				> = {};

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
						if (!byList[key])
							byList[key] = { events: 0, usd: 0, approximate: !handler };
						byList[key].events += list.length;

						for (const ev of list) {
							noteDate(dateOf(ev));
							byList[key].usd += handler ? handler(ev) : sumAllAmountsUnsafe(ev);
						}
					}
				}

				/* --- shipment events broken down, per SKU, with dates --- */

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
						first_sale: string | null;
						last_sale: string | null;
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
							first_sale: null,
							last_sale: null,
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
								if (!b.first_sale || posted < b.first_sale) b.first_sale = posted;
								if (!b.last_sale || posted > b.last_sale) b.last_sale = posted;
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

				/* --- named lines --- */

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
					revenue +
					totalCosts +
					adjustments +
					debtRecovery +
					liquidations +
					removals +
					otherTotal;

				/* --- per-SKU table --- */

				const skuRows = Object.entries(perSku)
					.map(([sku, v]) => {
						const net = v.revenue + v.fees + v.promos + v.refunds;
						const cogs = COGS[sku];
						const row: any = {
							sku,
							units: v.units,
							first_sale: v.first_sale,
							last_sale: v.last_sale,
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

				/* --- warnings --- */

				const warnings: string[] = [];

				if (!useSettlements && window > 90) {
					warnings.push(
						"WINDOW OVER 90 DAYS WITHOUT by_settlement. Amazon does not guarantee that listFinancialEvents returns every event over a wide date range, and it returns no signal when it does not. A 430-day pull on this account returned FEWER events than a 365-day pull and dropped a whole SKU. Re-run with by_settlement: true before trusting any total here."
					);
				}
				if (hitPageLimit) {
					warnings.push("PAGE LIMIT HIT. Results are incomplete. Narrow the window.");
				}
				if (approximateLists.length) {
					warnings.push(
						"APPROXIMATE EVENT TYPES: " +
							approximateLists.join(", ") +
							". These have no explicit handler in this file, so their totals come from a generic walk that cannot tell a total apart from its own components. Add a handler in EVENT_HANDLERS before relying on them."
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
							{
								events: v.events,
								usd: money(v.usd),
								...(v.approximate ? { approximate: true } : {}),
							},
						])
					),

					notes: [
						"Advertising uses transactionValue only. v2 added baseValue + taxValue + transactionValue and roughly doubled it.",
						"per_sku net EXCLUDES advertising and storage — those are account-level, not per-SKU. Only summary.net_usd is the real bottom line.",
						"Landed cost is not available from Amazon. Contribution appears only for SKUs listed in the COGS constant at the top of this file.",
						"Clicks, CPC, impressions and ACOS require the Amazon Ads API. This tool gives total spend only.",
					],
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

				const daysSince = (iso: string | undefined) =>
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

					oldest_order_in_window: orders.length
						? orders[orders.length - 1].PurchaseDate
						: null,

					by_status: byStatus,
					by_fulfillment_channel: byChannel,

					by_month: Object.fromEntries(
						Object.entries(byMonth)
							.sort((a, b) => b[0].localeCompare(a[0]))
							.map(([m, v]) => [
								m,
								{ orders: v.orders, units: v.units, gross_usd: money(v.gross) },
							])
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
								if (!perSku[sku])
									perSku[sku] = { units: 0, revenue: 0, orders: 0, last_sale: null };
								perSku[sku].units += Number(it.QuantityOrdered || 0);
								perSku[sku].revenue += amountOf(it.ItemPrice);
								perSku[sku].orders += 1;
								const d0 = o.PurchaseDate;
								if (d0 && (!perSku[sku].last_sale || d0 > perSku[sku].last_sale!)) {
									perSku[sku].last_sale = d0;
								}
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
							last_sale: v.last_sale,
							days_since_last_sale: daysSince(v.last_sale || undefined),
						}))
						.sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd));

					out.per_sku_note =
						cap < orders.length
							? "Based on the most recent " + cap + " of " + orders.length + " orders."
							: "Covers all " + orders.length + " orders in the window.";
				}

				out.note =
					"units counts shipped plus unshipped items and therefore includes cancelled orders. Compare against by_status before quoting it.";

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
					const path = nextToken
						? base + "&pageToken=" + encodeURIComponent(nextToken)
						: base;
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
						issues: issues
							.map((x: any) => x.code + " (" + x.severity + "): " + x.message)
							.slice(0, 5),
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
						"DISCOVERABLE without BUYABLE means the detail page exists but nothing can be bought. That is normal at zero inventory and also what a suppressed listing looks like — check the suppressed flag to tell them apart.",
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

				// Surface the things that are easy to miss inside a large attribute blob.
				const s = (data?.summaries || [])[0] || {};
				const po = (data?.attributes?.purchasable_offer || [])[0] || {};
				const flags = {
					status: (s.status || []).join(", "),
					buyable: (s.status || []).includes("BUYABLE"),
					offer_starts: po?.start_at?.value ?? null,
					offer_ends: po?.end_at?.value ?? null,
					offer_ended: po?.end_at?.value
						? new Date(po.end_at.value).getTime() < Date.now()
						: false,
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

	/* ---------------- SETTLEMENTS ---------------- */

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
					// v2 called this converted_total_usd. It is NOT USD — it is the
					// disbursement currency, GBP on this account at roughly 0.728.
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

				// Money that is sitting in a period whose transfer failed.
				const stuck: Record<string, number> = {};
				for (const g of failed) {
					const bal = Number(g.beginning_balance);
					if (bal > 0) stuck[g.beginning_balance] = (stuck[g.beginning_balance] || 0) + 1;
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
									amount:
										succeeded[0].converted_total + " " + succeeded[0].disbursement_currency,
							  }
							: null,
					},

					settlements: groups,

					note:
						"A balance that repeats unchanged across many Failed periods is a deposit-method fault, not a rounding issue. Seller Central → Payments → Deposit Methods. converted_total is the disbursement currency, not USD.",
				});
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
