import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const SP_HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SELLER_ID = "A2ZPQEA709W727";

/* ==================================================================
   v5.0 — 10 September 2026

   v4 gave the account its own numbers. v5 gives it the MARKET's.

   WHY v5 EXISTS
   Three screening rounds — 4,116 products, 46 full CPC tests — found
   zero survivors. Every one died on a number that a third-party tool
   had estimated wrongly: a price that was not the real page median, a
   review wall that Black Box could not see, a "season" field that
   measured listing growth. Amazon publishes the correct versions of
   all three in Brand Analytics, free, and v4 could not reach them.

   WHAT WAS ACTUALLY BROKEN
   run_report called createAndWait with reportOptions = undefined and a
   rolling N-day window. Brand Analytics reports REQUIRE:
       reportOptions.reportPeriod  =  WEEK | MONTH | QUARTER
       dataStartTime / dataEndTime aligned EXACTLY to that period
   A quarterly report cannot be built from "the last 30 days", so
   Amazon rejected it at build time and returned a bare FATAL with no
   reason attached. Waiting would never have fixed it.

   NEW IN v5
     get_top_search_terms          Amazon's own search frequency rank and
                                   the top-3 clicked products' CLICK SHARE
                                   for every search term in a category.
                                   Click share under ~12% means no product
                                   owns the term. Copper water bottle was
                                   8.03%; kosdeg 50.14%; cleo 67.60%.
                                   This is the fragmentation gate.
     get_search_query_performance  Impressions, clicks, cart adds and
                                   purchases per query for your own ASINs.
     get_search_catalog_performance  The same engagement funnel across the
                                   whole catalogue.
     get_market_basket             What customers buy alongside your ASIN.
     get_repeat_purchase           Repeat purchase behaviour.
     run_report                    Now accepts report_period + period_start
                                   and passes reportOptions properly.

   ALSO FIXED
     createAndWait now returns Amazon's full report record, so a FATAL
     comes back with whatever detail Amazon attached instead of silence.
     periodWindow() snaps dates to real quarter, month and week edges.

   STILL IMPOSSIBLE, WHATEVER THE CODE DOES
     Clicks, CPC, impressions, ACOS, keyword spend → Amazon Ads API,
       a SEPARATE application. (v6, 29 Sep 2026: now connected — see
       the ADS v1 section below.)
     Account Health score, reviews, star ratings → not exposed by SP-API.
     Landed cost → Amazon never knows what you paid your supplier.
     Deposit method settings → Seller Central screen only.

   CARRIED OVER FROM v4
     Explicit per-event maths, no double counting.
     by_settlement mode. GZIP handled inside the Worker.
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

/** Reports Amazon will not build without reportOptions.reportPeriod. */
const PERIOD_REPORTS = new Set([
	"GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT",
	"GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT",
	"GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT",
	"GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT",
	"GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT",
	"GET_BRAND_ANALYTICS_ITEM_COMPARISON_REPORT",
	"GET_BRAND_ANALYTICS_ALTERNATE_PURCHASE_REPORT",
]);

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
		if (!res.ok) throw new Error("SP-API " + res.status + ": " + text.slice(0, 600));
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

function pct(n: number): string {
	return (n * 100).toFixed(2) + "%";
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
/*  PERIOD ALIGNMENT — the v5 fix                                      */
/* ------------------------------------------------------------------ */

/**
 * Brand Analytics reports are built per calendar period. The window has to
 * land exactly on that period's edges — Q2 2026 is 2026-04-01 to 2026-06-30,
 * not "the last 90 days". Passing a rolling window is what produced FATAL.
 *
 * anchor: any date inside the period you want, e.g. "2026-04-01".
 *         Omit it and you get the most recently COMPLETED period, since the
 *         current one is not published yet.
 */
function periodWindow(period: string, anchor?: string): { start: string; end: string; label: string } {
	let d: Date;

	if (anchor) {
		d = new Date(anchor + "T00:00:00Z");
	} else {
		// Step back into the last completed period.
		const now = new Date();
		if (period === "QUARTER") {
			d = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 - 3, 1));
		} else if (period === "MONTH") {
			d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
		} else {
			d = new Date(now.getTime() - 7 * 86400000);
		}
	}

	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	let start: Date;
	let end: Date;
	let label: string;

	if (period === "QUARTER") {
		const qStart = Math.floor(m / 3) * 3;
		start = new Date(Date.UTC(y, qStart, 1));
		end = new Date(Date.UTC(y, qStart + 3, 0));
		label = y + " Q" + (Math.floor(qStart / 3) + 1);
	} else if (period === "MONTH") {
		start = new Date(Date.UTC(y, m, 1));
		end = new Date(Date.UTC(y, m + 1, 0));
		label = start.toISOString().slice(0, 7);
	} else {
		// Amazon weeks run Sunday to Saturday.
		const dow = d.getUTCDay();
		start = new Date(Date.UTC(y, m, d.getUTCDate() - dow));
		end = new Date(Date.UTC(y, m, d.getUTCDate() - dow + 6));
		label = "week of " + start.toISOString().slice(0, 10);
	}

	return {
		start: start.toISOString().slice(0, 10) + "T00:00:00Z",
		end: end.toISOString().slice(0, 10) + "T23:59:59Z",
		label,
	};
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

/**
 * Creates a report and waits for it.
 *
 * v5: accepts an explicit window (for period-aligned Brand Analytics
 * reports) and returns the FULL report record on failure, so a FATAL
 * arrives with whatever Amazon attached rather than nothing at all.
 */
async function createAndWait(
	reportType: string,
	days: number,
	reportOptions: any | undefined,
	waitSeconds: number,
	explicitWindow?: { start: string; end: string }
) {
	const body: any = {
		reportType,
		marketplaceIds: [MARKETPLACE_ID],
	};

	if (explicitWindow) {
		body.dataStartTime = explicitWindow.start;
		body.dataEndTime = explicitWindow.end;
	} else {
		body.dataStartTime = daysAgoISO(days);
		body.dataEndTime = new Date(Date.now() - 60000).toISOString();
	}

	if (reportOptions) body.reportOptions = reportOptions;

	let created: any;
	try {
		created = await spPost("/reports/2021-06-30/reports", body);
	} catch (e: any) {
		// Amazon refused the REQUEST, not the build. This is the useful error.
		return {
			reportId: null,
			status: "REQUEST_REJECTED",
			documentId: null,
			info: null,
			sentBody: body,
			rejectionMessage: e?.message || String(e),
		};
	}

	const reportId = created.reportId;
	const deadline = Date.now() + waitSeconds * 1000;
	let status = "IN_QUEUE";
	let documentId: string | null = null;
	let info: any = null;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5000));
		info = await spGet("/reports/2021-06-30/reports/" + encodeURIComponent(reportId));
		status = info.processingStatus;
		if (status === "DONE") {
			documentId = info.reportDocumentId;
			break;
		}
		if (status === "CANCELLED" || status === "FATAL") break;
	}

	return { reportId, status, documentId, info, sentBody: body, rejectionMessage: null };
}

/**
 * When a Brand Analytics report FAILS, Amazon sometimes still writes a
 * document explaining why. Fetch it if it exists.
 */
async function fatalReason(info: any): Promise<string | null> {
	try {
		if (info?.reportDocumentId) {
			const text = await downloadReportDocument(info.reportDocumentId);
			return text.slice(0, 1200);
		}
	} catch {
		/* nothing usable */
	}
	return null;
}

/** Shared handler for every Brand Analytics report. */
async function runBrandAnalytics(
	reportType: string,
	period: string,
	periodStart: string | undefined,
	extraOptions: any,
	waitSeconds: number
) {
	const win = periodWindow(period, periodStart);
	const options = { reportPeriod: period, ...extraOptions };

	const r = await createAndWait(reportType, 0, options, waitSeconds, win);

	if (r.status === "REQUEST_REJECTED") {
		return {
			ok: false,
			status: r.status,
			report_type: reportType,
			period: win.label,
			window: { start: win.start, end: win.end },
			report_options_sent: options,
			amazon_message: r.rejectionMessage,
			diagnosis:
				"Amazon refused the request itself. If it mentions a role, the Brand Analytics role is not live on the app yet — re-Authorize and replace SP_REFRESH_TOKEN. If it mentions reportOptions, the option names below are wrong for this report type.",
		};
	}

	if (r.status !== "DONE" || !r.documentId) {
		const why = await fatalReason(r.info);
		return {
			ok: false,
			status: r.status,
			report_id: r.reportId,
			report_type: reportType,
			period: win.label,
			window: { start: win.start, end: win.end },
			report_options_sent: options,
			amazon_detail: why,
			diagnosis:
				r.status === "FATAL"
					? "Amazon accepted the request but could not build it. Two usual causes: (1) the Brand Analytics role is ticked on the app but the refresh token predates it — re-Authorize and replace SP_REFRESH_TOKEN; (2) the period is not published yet — try the previous quarter."
					: "Still building. Call get_report with this report_id shortly.",
		};
	}

	const raw = await downloadReportDocument(r.documentId);
	const trimmed = raw.trim();
	const data = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : parseTSV(raw, 2000);

	return {
		ok: true,
		report_id: r.reportId,
		report_type: reportType,
		period: win.label,
		window: { start: win.start, end: win.end },
		data,
	};
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

/* ==================================================================
   ADS v1 — 29 September 2026 — Amazon Ads API (Sponsored Products)

   Uses its OWN Login with Amazon app ("AH Inside Ads API"), not the
   SP-API app. The SP-API keys cannot carry the advertising scope.

   Cloudflare secrets (Settings → Variables and Secrets):
     ADS_CLIENT_ID       Client ID of the AH Inside Ads API security profile
     ADS_CLIENT_SECRET   Client Secret of the same profile
     ADS_REFRESH_TOKEN   Shown once by the /ads-callback page after "Allow"
   Optional plain variables:
     ADS_PROFILE_ID        Force one advertising profile (default: the US seller profile)
     ADS_MAX_BID           Highest bid the Worker will ever send (default 1.07)
     ADS_MAX_DAILY_BUDGET  Highest daily budget it will ever set (default 10)

   GUARDRAILS — enforced here, whatever the chat asks for:
     1. Manual campaigns and EXACT-match keywords only. No auto, broad or phrase.
     2. No bid above ADS_MAX_BID (90% of break-even CPC; pantry baskets $1.07).
     3. An existing keyword's bid can only go DOWN.
     4. No daily budget above ADS_MAX_DAILY_BUDGET.
     5. New campaigns are created PAUSED, with dynamic bids "down only".
     6. Every write returns a PREVIEW. Nothing changes unless confirm = true.
     7. Keywords are never archived (deleted), only paused.
   Reports flag any keyword or search term with 86+ clicks and fewer
   than 3 orders for pausing (Part 12).

   ADS v2 — 30 September 2026 — "everything except DSP"
     Reports: SP campaigns, daily, ad groups, placements, keywords,
       search terms, advertised products, purchased products (halo);
       Sponsored Brands campaigns + search terms; Sponsored Display
       campaigns + targeting. Refused columns are dropped and retried.
     Amazon's own suggested bids and suggested keywords.
     SB / SD campaigns and portfolios — READ ONLY (rules: SP only).
     Budget usage today; change history (~90 days).
     Overview now also shows product/auto targets and campaign-level
     and product negatives.
     Not included: DSP (by request), Amazon Marketing Cloud (separate
     paid instance), Marketing Stream (needs AWS queues).

   ADS v3 — 30 September 2026 — full Sponsored Products control
     New writes: ad groups (add, bid, state, name), product ads (add,
     pause), product/ASIN targets and auto target groups, negative
     product targets, campaign-level negatives, campaign name / end
     date / bidding strategy / placement boosts, archive (permanent,
     needs confirm_text ARCHIVE), SB/SD pause/enable/budget.
     Money limits always on. Rule limits are SWITCHES Adnan sets as
     Cloudflare variables: ADS_ALLOW_BID_INCREASE, ADS_ALLOWED_MATCH_TYPES,
     ADS_ALLOW_AUTO, ADS_ALLOW_PRODUCT_TARGETING, ADS_MAX_PLACEMENT_PERCENT.
   ================================================================== */

const ADS_HOST = "https://advertising-api.amazon.com";
const ADS_CALLBACK_PATH = "/ads-callback";
const PAUSE_MIN_CLICKS = 86;
const PAUSE_MAX_ORDERS = 3;

const ADS_TYPE = {
	campaign: "application/vnd.spCampaign.v3+json",
	adGroup: "application/vnd.spAdGroup.v3+json",
	keyword: "application/vnd.spKeyword.v3+json",
	negativeKeyword: "application/vnd.spNegativeKeyword.v3+json",
	productAd: "application/vnd.spProductAd.v3+json",
	report: "application/vnd.createasyncreportrequest.v3+json",
	target: "application/vnd.spTargetingClause.v3+json",
	campaignNegativeKeyword: "application/vnd.spCampaignNegativeKeyword.v3+json",
	negativeTarget: "application/vnd.spNegativeTargetingClause.v3+json",
};

let adsToken: string | null = null;
let adsTokenExpiry = 0;
let adsProfileId: string | null = null;

function envTrue(key: string): boolean {
	return String(currentEnv?.[key] ?? "").trim().toLowerCase() === "true";
}

/**
 * Money guardrails (always on) and rule SWITCHES (off unless Adnan sets them
 * as Cloudflare variables). Every switch is his decision, made in Cloudflare,
 * never by the chat.
 *   ADS_MAX_BID                   bid cap, default 1.07
 *   ADS_MAX_DAILY_BUDGET          budget ceiling per campaign, default 10
 *   ADS_ALLOW_BID_INCREASE=true   allows raising bids (still under the cap)
 *                                 and "up and down" dynamic bidding
 *   ADS_ALLOWED_MATCH_TYPES       default EXACT; e.g. EXACT,PHRASE,BROAD
 *   ADS_ALLOW_AUTO=true           allows AUTO campaigns
 *   ADS_ALLOW_PRODUCT_TARGETING=true  allows ASIN / category targets
 *   ADS_MAX_PLACEMENT_PERCENT     top-of-search / product-page boosts, default 0 (off), max 900
 */
function adsLimits() {
	const bid = Number(currentEnv?.ADS_MAX_BID ?? 1.07);
	const budget = Number(currentEnv?.ADS_MAX_DAILY_BUDGET ?? 10);
	const placement = Number(currentEnv?.ADS_MAX_PLACEMENT_PERCENT ?? 0);
	const match = String(currentEnv?.ADS_ALLOWED_MATCH_TYPES ?? "EXACT")
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter((s) => ["EXACT", "PHRASE", "BROAD"].includes(s));
	return {
		maxBid: Number.isFinite(bid) && bid > 0 ? bid : 1.07,
		maxDailyBudget: Number.isFinite(budget) && budget > 0 ? budget : 10,
		allowBidIncrease: envTrue("ADS_ALLOW_BID_INCREASE"),
		allowedMatch: match.length ? match : ["EXACT"],
		allowAuto: envTrue("ADS_ALLOW_AUTO"),
		allowProductTargeting: envTrue("ADS_ALLOW_PRODUCT_TARGETING"),
		maxPlacementPercent: Number.isFinite(placement) ? Math.max(0, Math.min(placement, 900)) : 0,
	};
}

function switchesSummary() {
	const l = adsLimits();
	return {
		bid_cap: money(l.maxBid),
		max_daily_budget: money(l.maxDailyBudget),
		bid_increases: l.allowBidIncrease ? "ALLOWED (under cap)" : "blocked — set ADS_ALLOW_BID_INCREASE=true to allow",
		match_types: l.allowedMatch.join(", "),
		auto_campaigns: l.allowAuto ? "ALLOWED" : "blocked — set ADS_ALLOW_AUTO=true to allow",
		product_targeting: l.allowProductTargeting ? "ALLOWED" : "blocked — set ADS_ALLOW_PRODUCT_TARGETING=true to allow",
		placement_boost_max: l.maxPlacementPercent ? l.maxPlacementPercent + "%" : "off — set ADS_MAX_PLACEMENT_PERCENT to allow",
		writes: "preview unless confirm = true; archive also needs confirm_text ARCHIVE",
	};
}

function adsSecretsMissing(): string | null {
	const missing = ["ADS_CLIENT_ID", "ADS_CLIENT_SECRET", "ADS_REFRESH_TOKEN"].filter(
		(k) => !currentEnv?.[k]
	);
	return missing.length
		? "Amazon Ads secrets missing: " +
				missing.join(", ") +
				". Add them in Cloudflare → Workers → remote-mcp-server-authless → Settings → Variables and Secrets."
		: null;
}

async function getAdsToken(): Promise<string> {
	const missing = adsSecretsMissing();
	if (missing) throw new Error(missing);

	const now = Date.now();
	if (adsToken && now < adsTokenExpiry) return adsToken;

	const res = await fetch("https://api.amazon.com/auth/o2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: currentEnv.ADS_REFRESH_TOKEN,
			client_id: currentEnv.ADS_CLIENT_ID,
			client_secret: currentEnv.ADS_CLIENT_SECRET,
		}).toString(),
	});
	if (!res.ok) throw new Error("Ads token request failed " + res.status + ": " + (await res.text()));

	const data: any = await res.json();
	adsToken = data.access_token;
	adsTokenExpiry = now + (data.expires_in - 120) * 1000;
	return adsToken as string;
}

async function adsRequest(
	method: string,
	path: string,
	opts: { body?: any; type?: string; scoped?: boolean } = {}
): Promise<any> {
	const token = await getAdsToken();
	const headers: Record<string, string> = {
		Authorization: "Bearer " + token,
		"Amazon-Advertising-API-ClientId": currentEnv.ADS_CLIENT_ID,
	};
	if (opts.scoped !== false) headers["Amazon-Advertising-API-Scope"] = await getAdsProfileId();
	if (opts.type) {
		headers["Content-Type"] = opts.type;
		headers["Accept"] = opts.type;
	} else if (opts.body) {
		headers["Content-Type"] = "application/json";
	}

	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(ADS_HOST + path, {
			method,
			headers,
			body: opts.body ? JSON.stringify(opts.body) : undefined,
		});
		if (res.status === 429 || res.status >= 500) {
			await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			continue;
		}
		const text = await res.text();
		if (!res.ok) throw new Error("Ads API " + res.status + ": " + text.slice(0, 800));
		return text ? JSON.parse(text) : {};
	}
	throw new Error("Ads API throttled after 4 attempts");
}

async function listAdsProfiles(): Promise<any[]> {
	const out = await adsRequest("GET", "/v2/profiles", { scoped: false });
	return Array.isArray(out) ? out : [];
}

/** The US seller profile, unless ADS_PROFILE_ID says otherwise. */
async function getAdsProfileId(): Promise<string> {
	if (currentEnv?.ADS_PROFILE_ID) return String(currentEnv.ADS_PROFILE_ID);
	if (adsProfileId) return adsProfileId;

	const profiles = await listAdsProfiles();
	const us = profiles.filter((p) => p.countryCode === "US");
	const pick = us.find((p) => p.accountInfo?.type === "seller") || us[0];
	if (!pick) {
		throw new Error(
			"No US advertising profile found on this Amazon account. Profiles returned: " +
				JSON.stringify(profiles.map((p) => ({ id: p.profileId, country: p.countryCode, type: p.accountInfo?.type })))
		);
	}
	adsProfileId = String(pick.profileId);
	return adsProfileId;
}

/** Sponsored Products v3 list endpoints, all pages. */
async function adsList(path: string, type: string, key: string, filter: any = {}): Promise<any[]> {
	const items: any[] = [];
	let nextToken: string | undefined;
	for (let page = 0; page < 10; page++) {
		const body: any = { maxResults: 1000, ...filter };
		if (nextToken) body.nextToken = nextToken;
		const out = await adsRequest("POST", path, { body, type });
		items.push(...(out[key] || []));
		nextToken = out.nextToken;
		if (!nextToken) break;
	}
	return items;
}

/** v3 writes answer { key: { success: [...], error: [...] } }. */
function adsWriteResult(out: any, key: string) {
	const block = out?.[key] || {};
	return { success: block.success || [], error: block.error || [] };
}

const LIVE_STATES = { include: ["ENABLED", "PAUSED"] };

function todayISODate(): string {
	return new Date().toISOString().slice(0, 10);
}

function cleanKeyword(text: string): string {
	return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Checks a set of new exact keywords against the bid cap. */
function checkNewKeywords(keywords: { text: string; bid: number }[], maxBid: number): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const k of keywords) {
		const t = cleanKeyword(k.text);
		if (!t) problems.push("Empty keyword.");
		if (t.split(" ").length > 10) problems.push('"' + t + '" has more than 10 words.');
		if (seen.has(t)) problems.push('"' + t + '" is listed twice.');
		seen.add(t);
		if (!(k.bid > 0)) problems.push('"' + t + '" has no bid.');
		if (k.bid < 0.02) problems.push('"' + t + '" bid $' + money(k.bid) + " is below Amazon's $0.02 minimum.");
		if (k.bid > maxBid)
			problems.push('"' + t + '" bid $' + money(k.bid) + " is above the $" + money(maxBid) + " bid cap.");
	}
	return problems;
}

/* ---------------- REPORTS (v3, asynchronous) — ADS v2 ----------------
   Every report Amazon offers except DSP. Amazon keeps report data for a
   limited window (Sponsored Products ≈ 95 days); older dates are refused.
   If Amazon rejects a column, the Worker drops it and retries once.
   -------------------------------------------------------------------- */

type AdsReportCfg = {
	adProduct: "SPONSORED_PRODUCTS" | "SPONSORED_BRANDS" | "SPONSORED_DISPLAY";
	reportTypeId: string;
	groupBy: string[];
	columns: string[];
	timeUnit?: "SUMMARY" | "DAILY";
	flags?: "keywords" | "search_terms";
	note: string;
};

const SP_METRICS = ["impressions", "clicks", "cost", "purchases7d", "sales7d", "unitsSoldClicks7d"];
const SB_METRICS = ["impressions", "clicks", "cost", "purchases", "sales", "unitsSold"];
const SD_METRICS = ["impressions", "clicks", "cost", "purchases", "sales", "unitsSold"];

const ADS_REPORTS: Record<string, AdsReportCfg> = {
	/* ---- Sponsored Products ---- */
	campaigns: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spCampaigns", groupBy: ["campaign"],
		columns: ["campaignName", "campaignId", "campaignStatus", "campaignBudgetAmount", ...SP_METRICS],
		note: "SP: one row per campaign.",
	},
	campaigns_daily: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spCampaigns", groupBy: ["campaign"], timeUnit: "DAILY",
		columns: ["date", "campaignName", "campaignId", ...SP_METRICS],
		note: "SP: one row per campaign per day — the trend.",
	},
	ad_groups: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spCampaigns", groupBy: ["campaign", "adGroup"],
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", ...SP_METRICS],
		note: "SP: one row per ad group.",
	},
	placements: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spCampaigns", groupBy: ["campaign", "campaignPlacement"],
		columns: ["campaignName", "campaignId", "placementClassification", ...SP_METRICS],
		note: "SP: top of search vs rest of search vs product pages.",
	},
	keywords: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spTargeting", groupBy: ["targeting"], flags: "keywords",
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "keywordId", "keyword",
			"matchType", "targeting", "keywordBid", ...SP_METRICS],
		note: "SP: one row per keyword or product target.",
	},
	search_terms: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spSearchTerm", groupBy: ["searchTerm"], flags: "search_terms",
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "keywordId", "keyword",
			"matchType", "searchTerm", ...SP_METRICS],
		note: "SP: what shoppers actually typed.",
	},
	advertised_products: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spAdvertisedProduct", groupBy: ["advertiser"],
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "advertisedAsin", "advertisedSku",
			...SP_METRICS],
		note: "SP: results per advertised ASIN/SKU.",
	},
	purchased_products: {
		adProduct: "SPONSORED_PRODUCTS", reportTypeId: "spPurchasedProduct", groupBy: ["asin"],
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "keyword", "matchType",
			"advertisedAsin", "advertisedSku", "purchasedAsin",
			"purchasesOtherSku7d", "salesOtherSku7d", "unitsSoldOtherSku7d"],
		note: "SP: other ASINs shoppers bought after clicking your ad (halo sales).",
	},
	/* ---- Sponsored Brands (read only — your rules do not run these) ---- */
	sb_campaigns: {
		adProduct: "SPONSORED_BRANDS", reportTypeId: "sbCampaigns", groupBy: ["campaign"],
		columns: ["campaignName", "campaignId", "campaignStatus", "campaignBudgetAmount", ...SB_METRICS],
		note: "SB (headline/video): one row per campaign. 14-day attribution.",
	},
	sb_search_terms: {
		adProduct: "SPONSORED_BRANDS", reportTypeId: "sbSearchTerm", groupBy: ["searchTerm"], flags: "search_terms",
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "keywordText", "matchType",
			"searchTerm", ...SB_METRICS],
		note: "SB: what shoppers typed. 14-day attribution.",
	},
	/* ---- Sponsored Display (read only) ---- */
	sd_campaigns: {
		adProduct: "SPONSORED_DISPLAY", reportTypeId: "sdCampaigns", groupBy: ["campaign"],
		columns: ["campaignName", "campaignId", "campaignStatus", "campaignBudgetAmount", ...SD_METRICS],
		note: "SD: one row per campaign. 14-day attribution.",
	},
	sd_targeting: {
		adProduct: "SPONSORED_DISPLAY", reportTypeId: "sdTargeting", groupBy: ["targeting"],
		columns: ["campaignName", "campaignId", "adGroupName", "adGroupId", "targetingText", "targetingExpression",
			...SD_METRICS],
		note: "SD: one row per audience or product target.",
	},
};

const ADS_REPORT_KINDS = Object.keys(ADS_REPORTS) as [string, ...string[]];

function reportBody(kind: string, startDate: string, endDate: string, columns: string[]) {
	const cfg = ADS_REPORTS[kind];
	return {
		name: "AH Inside " + kind + " " + startDate + " to " + endDate,
		startDate,
		endDate,
		configuration: {
			adProduct: cfg.adProduct,
			groupBy: cfg.groupBy,
			columns,
			reportTypeId: cfg.reportTypeId,
			timeUnit: cfg.timeUnit || "SUMMARY",
			format: "GZIP_JSON",
		},
	};
}

/** Creates a report. If Amazon names columns it does not accept, drops them and retries once. */
async function adsCreateReport(kind: string, startDate: string, endDate: string) {
	const cfg = ADS_REPORTS[kind];
	if (!cfg) throw new Error("Unknown report kind: " + kind);
	let columns = [...cfg.columns];
	try {
		const out = await adsRequest("POST", "/reporting/reports", { type: ADS_TYPE.report, body: reportBody(kind, startDate, endDate, columns) });
		return { ...out, dropped_columns: [] as string[] };
	} catch (e: any) {
		const msg = String(e?.message || e);
		if (!/column/i.test(msg)) throw e;
		const allowedMatch = msg.match(/allowed values?[^\[]*\[([^\]]+)\]/i);
		let dropped: string[];
		if (allowedMatch) {
			const allowed = new Set(allowedMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")));
			dropped = columns.filter((c) => !allowed.has(c));
		} else {
			dropped = columns.filter((c) => new RegExp("\\b" + c + "\\b").test(msg));
		}
		if (!dropped.length) throw e;
		columns = columns.filter((c) => !dropped.includes(c));
		const out = await adsRequest("POST", "/reporting/reports", { type: ADS_TYPE.report, body: reportBody(kind, startDate, endDate, columns) });
		return { ...out, dropped_columns: dropped };
	}
}

/** Polls a report; downloads and summarises it once COMPLETED. */
async function adsFetchReport(reportId: string, kind: string, waitSeconds: number) {
	const deadline = Date.now() + waitSeconds * 1000;
	let info: any = await adsRequest("GET", "/reporting/reports/" + encodeURIComponent(reportId));
	while (info.status !== "COMPLETED" && info.status !== "FAILED" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 8000));
		info = await adsRequest("GET", "/reporting/reports/" + encodeURIComponent(reportId));
	}

	if (info.status === "FAILED") {
		return { report_id: reportId, status: "FAILED", reason: info.failureReason || null };
	}
	if (info.status !== "COMPLETED") {
		return {
			report_id: reportId,
			status: info.status,
			next_step: "Amazon is still building it. Call ads_get_report with this report_id and kind in a few minutes.",
		};
	}

	const res = await fetch(info.url);
	if (!res.ok) throw new Error("Ads report download failed " + res.status);
	const text = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
	const rows: any[] = text ? JSON.parse(text) : [];
	return { report_id: reportId, status: "COMPLETED", ...summariseAdsRows(rows, kind) };
}

/** Reads sales/orders whatever the ad product calls them. */
function rowSales(r: any): number {
	return Number(r.sales7d ?? r.sales14d ?? r.sales ?? r.salesClicks ?? r.salesOtherSku7d ?? 0);
}
function rowOrders(r: any): number {
	return Number(r.purchases7d ?? r.purchases14d ?? r.purchases ?? r.purchasesClicks ?? r.purchasesOtherSku7d ?? 0);
}

function summariseAdsRows(rows: any[], kind: string) {
	const { maxBid } = adsLimits();
	const cfg = ADS_REPORTS[kind];
	let clicks = 0, cost = 0, sales = 0, orders = 0, impressions = 0;

	const out = rows.map((r) => {
		const c = Number(r.clicks || 0);
		const spend = Number(r.cost || 0);
		const s = rowSales(r);
		const o = rowOrders(r);
		clicks += c; cost += spend; sales += s; orders += o; impressions += Number(r.impressions || 0);

		const row: any = { ...r };
		if ("clicks" in r || "cost" in r) {
			row.cpc = c ? money(spend / c) : null;
			row.acos = s ? pct(spend / s) : spend ? "no sales" : null;
			row.cvr = c ? pct(o / c) : null;
		}
		if (cfg?.flags) {
			if (c >= PAUSE_MIN_CLICKS && o < PAUSE_MAX_ORDERS) row.flag = "PAUSE: " + c + " clicks, " + o + " orders";
			if (cfg.flags === "search_terms" && c >= 10 && o === 0 && !row.flag) row.flag = "WATCH: negative candidate";
			if (cfg.flags === "search_terms" && o >= 2 && String(r.matchType || "").toUpperCase() !== "EXACT")
				row.flag = "HARVEST: add as exact keyword";
			if (cfg.flags === "keywords" && Number(r.keywordBid) > maxBid && !row.flag)
				row.flag = "OVER CAP: bid $" + money(Number(r.keywordBid)) + " > $" + money(maxBid);
		}
		return row;
	});

	if (cfg?.timeUnit === "DAILY") out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
	else out.sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0) || rowSales(b) - rowSales(a));

	return {
		kind,
		about: cfg?.note,
		rows: out.length,
		totals: {
			impressions,
			clicks,
			spend: money(cost),
			sales: money(sales),
			orders,
			acos: sales ? pct(cost / sales) : null,
			cpc: clicks ? money(cost / clicks) : null,
			cvr: clicks ? pct(orders / clicks) : null,
		},
		rules: {
			bid_cap: money(maxBid),
			pause_rule: PAUSE_MIN_CLICKS + " clicks with fewer than " + PAUSE_MAX_ORDERS + " orders",
			attribution: cfg?.adProduct === "SPONSORED_PRODUCTS" ? "7-day click attribution" : "14-day attribution",
		},
		flagged: out.filter((r) => r.flag).slice(0, 100),
		data: out.slice(0, 300),
	};
}

/* ---------------- RECOMMENDATIONS (Amazon's own numbers) ---------------- */

/** Tries newer media-type versions first; falls back when Amazon says the version is unsupported. */
async function adsPostVersioned(path: string, types: string[], body: any): Promise<{ out: any; type: string }> {
	let lastErr: any = null;
	for (const t of types) {
		try {
			return { out: await adsRequest("POST", path, { type: t, body }), type: t };
		} catch (e: any) {
			lastErr = e;
			if (!/ 415| 406|media type|content.?type|accept/i.test(String(e?.message || e))) throw e;
		}
	}
	throw lastErr;
}

function bidOf(x: any): number | null {
	if (x == null) return null;
	if (typeof x === "number") return x;
	const v = x.suggestedBid ?? x.bid ?? x.value ?? x.rangeMedian;
	return v == null ? null : Number(v);
}

/* ---------------- AUTHORIZATION CALLBACK PAGE ---------------- */

function htmlEscape(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
	);
}

function callbackPage(title: string, body: string, status = 200): Response {
	const html =
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
		"<title>" + htmlEscape(title) + "</title><style>" +
		"body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5;color:#1a1a1a}" +
		"textarea{width:100%;height:110px;font-family:monospace;font-size:13px}" +
		"button{padding:10px 16px;font-size:15px;margin-top:8px;cursor:pointer}" +
		".ok{color:#0a7a2f}.bad{color:#b00020}code{background:#f2f2f2;padding:1px 4px}" +
		"</style></head><body>" + body + "</body></html>";
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag": "noindex",
		},
	});
}

/** Amazon sends the browser here after "Allow". Swaps the one-time code for a refresh token. */
async function handleAdsCallback(url: URL): Promise<Response> {
	const error = url.searchParams.get("error");
	if (error) {
		return callbackPage(
			"Not connected",
			'<h2 class="bad">Amazon did not grant access</h2><p>' +
				htmlEscape(error + ": " + (url.searchParams.get("error_description") || "")) +
				"</p><p>Close this page. Nothing was changed.</p>",
			400
		);
	}

	const code = url.searchParams.get("code");
	if (!code) return callbackPage("Nothing to do", "<p>This page is only used after Amazon's Allow screen.</p>", 400);

	if (!currentEnv?.ADS_CLIENT_ID || !currentEnv?.ADS_CLIENT_SECRET) {
		return callbackPage(
			"Secrets missing",
			'<h2 class="bad">Add the Client ID and Client Secret first</h2>' +
				"<p>In Cloudflare, add the secrets <code>ADS_CLIENT_ID</code> and <code>ADS_CLIENT_SECRET</code>, wait one minute, then open the Amazon link again and click Allow.</p>",
			400
		);
	}

	const res = await fetch("https://api.amazon.com/auth/o2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: url.origin + ADS_CALLBACK_PATH,
			client_id: currentEnv.ADS_CLIENT_ID,
			client_secret: currentEnv.ADS_CLIENT_SECRET,
		}).toString(),
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok || !data.refresh_token) {
		return callbackPage(
			"Not connected",
			'<h2 class="bad">Amazon refused the code</h2><p>' +
				htmlEscape(String(data.error || res.status) + " " + String(data.error_description || "")) +
				"</p><p>The code works once and expires in 5 minutes. Open the Amazon link again and click Allow.</p>",
			400
		);
	}

	// Prove the token works by listing the advertising profiles it can see.
	let profilesHtml = "";
	try {
		const p = await fetch(ADS_HOST + "/v2/profiles", {
			headers: {
				Authorization: "Bearer " + data.access_token,
				"Amazon-Advertising-API-ClientId": currentEnv.ADS_CLIENT_ID,
			},
		});
		const list: any[] = p.ok ? await p.json() : [];
		profilesHtml = list.length
			? "<p>Advertising profiles found:</p><ul>" +
				list
					.map((x) =>
						"<li>" + htmlEscape(String(x.countryCode) + " · " + String(x.accountInfo?.type) + " · " +
							String(x.accountInfo?.name || "") + " · profile " + String(x.profileId)) + "</li>"
					)
					.join("") + "</ul>"
			: '<p class="bad">Token works, but Amazon returned no advertising profiles. Open Campaign Manager once with this account, then try again.</p>';
	} catch {
		profilesHtml = "<p>Could not list profiles right now; the token is still valid.</p>";
	}

	return callbackPage(
		"Connected",
		'<h2 class="ok">Amazon Ads connected ✅</h2>' +
			profilesHtml +
			"<p><b>Last step.</b> Copy the refresh token below and save it in Cloudflare as a <b>Secret</b> named <code>ADS_REFRESH_TOKEN</code>. " +
			"Do not paste it into any chat, email or photo.</p>" +
			'<textarea id="t" readonly>' + htmlEscape(data.refresh_token) + "</textarea><br>" +
			"<button onclick=\"navigator.clipboard.writeText(document.getElementById('t').value);this.textContent='Copied'\">Copy token</button>" +
			"<p>Then close this page. Amazon shows this token only once; if you lose it, open the Amazon link again and click Allow.</p>"
	);
}

/* ------------------------------------------------------------------ */
/*  SERVER                                                             */
/* ------------------------------------------------------------------ */

function createServer() {
	const server = new McpServer({
		name: "AH Inside Seller Central",
		version: "6.2.0",
	});

	/* ============ BRAND ANALYTICS — TOP SEARCH TERMS ============ */

	server.registerTool(
		"get_top_search_terms",
		{
			description:
				"THE FRAGMENTATION GATE. Amazon's own Top Search Terms: search frequency rank plus the top-3 clicked products with their CLICK SHARE and CONVERSION SHARE, for every search term. A #1 click share under ~12% means no product owns that term and a newcomer can take share; over ~20% means one brand owns it and you walk away. Copper water bottle was 8.03%, kosdeg 50.14%, cleo 67.60%. First-party data — not an estimate from any third-party tool. Filter by category, or search a specific term.",
			inputSchema: z.object({
				period: z
					.string()
					.optional()
					.describe("QUARTER, MONTH or WEEK. Default QUARTER."),
				period_start: z
					.string()
					.optional()
					.describe(
						"Any date inside the wanted period, e.g. 2026-04-01 for Q2 2026. Omit for the most recently completed period."
					),
				contains: z
					.string()
					.optional()
					.describe("Only return search terms containing this text, e.g. 'copper'."),
				max_click_share: z
					.number()
					.optional()
					.describe(
						"Only return terms whose #1 clicked product has a click share BELOW this fraction. 0.12 applies the fragmentation gate."
					),
				max_rank: z
					.number()
					.optional()
					.describe("Only return terms with a search frequency rank below this. 15000 is a sensible ceiling."),
				max_rows: z.number().optional().describe("Rows to return. Default 300."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 80."),
			}),
		},
		async ({ period, period_start, contains, max_click_share, max_rank, max_rows, wait_seconds }: any) => {
			try {
				const p = (period || "QUARTER").toUpperCase();
				const wait = Math.max(5, Math.min(wait_seconds ?? 80, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 300, 2000));

				const out = await runBrandAnalytics(
					"GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT",
					p,
					period_start,
					{},
					wait
				);

				if (!out.ok) return textResult(out);

				// Amazon nests the rows under a department-and-search-term key.
				const d: any = out.data;
				const rowsRaw: any[] = Array.isArray(d)
					? d
					: d.dataByDepartmentAndSearchTerm ||
					  d.dataByDepartmentAndSearchTermV2 ||
					  d.dataBySearchTerm ||
					  [];

				let rows = rowsRaw.map((r: any) => {
					const rank = Number(r.searchFrequencyRank ?? r.searchFrequencyRankV2 ?? 0);
					const c1 = Number(r.clickShare ?? r.clickedAsin1ClickShare ?? r.topClickedProduct1ClickShare ?? 0);
					const v1 = Number(
						r.conversionShare ?? r.clickedAsin1ConversionShare ?? r.topClickedProduct1ConversionShare ?? 0
					);
					return {
						search_term: r.searchTerm ?? r.departmentAndSearchTerm ?? null,
						department: r.departmentName ?? null,
						search_frequency_rank: rank,
						top1_asin: r.clickedAsin ?? r.clickedAsin1 ?? null,
						top1_title: r.clickedItemName ?? r.clickedAsin1Title ?? null,
						top1_click_share: c1,
						top1_click_share_pct: pct(c1),
						top1_conversion_share: v1,
						top1_conversion_share_pct: pct(v1),
						verdict:
							c1 === 0 ? "unknown" : c1 < 0.12 ? "OPEN — nobody owns it" : c1 < 0.2 ? "concentrating" : "OWNED — walk away",
						raw: r,
					};
				});

				if (contains) {
					const needle = String(contains).toLowerCase();
					rows = rows.filter((r) => String(r.search_term || "").toLowerCase().includes(needle));
				}
				if (max_rank) rows = rows.filter((r) => r.search_frequency_rank && r.search_frequency_rank <= max_rank);
				if (max_click_share) rows = rows.filter((r) => r.top1_click_share > 0 && r.top1_click_share <= max_click_share);

				rows.sort((a, b) => (a.search_frequency_rank || 1e9) - (b.search_frequency_rank || 1e9));

				const open = rows.filter((r) => r.top1_click_share > 0 && r.top1_click_share < 0.12).length;
				const owned = rows.filter((r) => r.top1_click_share >= 0.2).length;

				return textResult({
					pulled_at: new Date().toISOString(),
					report_id: out.report_id,
					period: out.period,
					window: out.window,
					total_terms_in_report: rowsRaw.length,
					terms_after_filters: rows.length,
					fragmentation: {
						open_under_12pct: open,
						owned_over_20pct: owned,
					},
					terms: rows.slice(0, limit).map(({ raw, ...rest }) => rest),
					notes: [
						"top1_click_share is the share of ALL clicks on this search term that went to the single most-clicked product. It is Amazon's own measurement.",
						"Under 12% means the clicks are spread across many products — that is an enterable market.",
						"Over 20% means one product absorbs most of the demand, which almost always means a brand search.",
						"search_frequency_rank is a rank, not a volume: rank 1 is the most searched term on Amazon. Lower is bigger.",
					],
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ============ BRAND ANALYTICS — SEARCH QUERY PERFORMANCE ============ */

	server.registerTool(
		"get_search_query_performance",
		{
			description:
				"Per-query impressions, clicks, cart adds and purchases for YOUR OWN ASINs, with your share of each. This is the only place Amazon shows what a keyword actually did for your listing. Brand Registry required.",
			inputSchema: z.object({
				asins: z
					.string()
					.optional()
					.describe("One ASIN or several separated by spaces or commas. Omit for brand level."),
				period: z.string().optional().describe("QUARTER, MONTH or WEEK. Default QUARTER."),
				period_start: z.string().optional().describe("Any date inside the wanted period, e.g. 2026-04-01."),
				max_rows: z.number().optional().describe("Rows to return. Default 200."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 80."),
			}),
		},
		async ({ asins, period, period_start, max_rows, wait_seconds }: any) => {
			try {
				const p = (period || "QUARTER").toUpperCase();
				const wait = Math.max(5, Math.min(wait_seconds ?? 80, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 200, 1000));

				const extra: any = {};
				if (asins) {
					extra.asin = String(asins).split(/[\s,]+/).filter(Boolean).join(" ");
				}

				const out = await runBrandAnalytics(
					"GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT",
					p,
					period_start,
					extra,
					wait
				);

				if (!out.ok) return textResult(out);

				const d: any = out.data;
				const rowsRaw: any[] = Array.isArray(d) ? d : d.dataByAsin || d.dataByDepartmentAndSearchTerm || [];

				const rows = rowsRaw.slice(0, limit).map((r: any) => ({
					search_query: r.searchQuery ?? null,
					query_volume: r.searchQueryData?.searchQueryVolume ?? null,
					impressions_total: r.impressionData?.totalQueryImpressionCount ?? null,
					impressions_yours: r.impressionData?.asinImpressionCount ?? null,
					impression_share: r.impressionData?.asinImpressionShare ?? null,
					clicks_total: r.clickData?.totalClickCount ?? null,
					clicks_yours: r.clickData?.asinClickCount ?? null,
					click_share: r.clickData?.asinClickShare ?? null,
					cart_adds_yours: r.cartAddData?.asinCartAddCount ?? null,
					purchases_total: r.purchaseData?.totalPurchaseCount ?? null,
					purchases_yours: r.purchaseData?.asinPurchaseCount ?? null,
					purchase_share: r.purchaseData?.asinPurchaseShare ?? null,
					asin: r.asin ?? null,
				}));

				return textResult({
					pulled_at: new Date().toISOString(),
					report_id: out.report_id,
					period: out.period,
					window: out.window,
					asins_requested: extra.asin || "brand level",
					rows_returned: rows.length,
					queries: rows,
					note:
						"impression_share below click_share means the listing converts attention well but is not being shown enough — a ranking problem, not a listing problem.",
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ============ BRAND ANALYTICS — SEARCH CATALOG PERFORMANCE ============ */

	server.registerTool(
		"get_search_catalog_performance",
		{
			description:
				"Search engagement across the whole catalogue: impressions, clicks, cart adds and purchases per ASIN for a period. Use it to see which SKUs are being found at all.",
			inputSchema: z.object({
				period: z.string().optional().describe("QUARTER, MONTH or WEEK. Default QUARTER."),
				period_start: z.string().optional().describe("Any date inside the wanted period."),
				max_rows: z.number().optional().describe("Rows to return. Default 200."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 80."),
			}),
		},
		async ({ period, period_start, max_rows, wait_seconds }: any) => {
			try {
				const p = (period || "QUARTER").toUpperCase();
				const wait = Math.max(5, Math.min(wait_seconds ?? 80, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 200, 1000));

				const out = await runBrandAnalytics(
					"GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT",
					p,
					period_start,
					{},
					wait
				);

				if (!out.ok) return textResult(out);

				const d: any = out.data;
				const rowsRaw: any[] = Array.isArray(d) ? d : d.dataByAsin || [];

				return textResult({
					pulled_at: new Date().toISOString(),
					report_id: out.report_id,
					period: out.period,
					window: out.window,
					rows_returned: Math.min(rowsRaw.length, limit),
					catalog: rowsRaw.slice(0, limit),
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ============ BRAND ANALYTICS — MARKET BASKET ============ */

	server.registerTool(
		"get_market_basket",
		{
			description:
				"What customers bought alongside your ASINs in the same order. Useful for bundle decisions and for spotting the accessory a niche is missing.",
			inputSchema: z.object({
				period: z.string().optional().describe("QUARTER, MONTH or WEEK. Default QUARTER."),
				period_start: z.string().optional().describe("Any date inside the wanted period."),
				max_rows: z.number().optional().describe("Rows to return. Default 100."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 80."),
			}),
		},
		async ({ period, period_start, max_rows, wait_seconds }: any) => {
			try {
				const p = (period || "QUARTER").toUpperCase();
				const wait = Math.max(5, Math.min(wait_seconds ?? 80, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 100, 500));

				const out = await runBrandAnalytics(
					"GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT",
					p,
					period_start,
					{},
					wait
				);

				if (!out.ok) return textResult(out);

				const d: any = out.data;
				const rowsRaw: any[] = Array.isArray(d) ? d : d.dataByAsin || [];

				return textResult({
					pulled_at: new Date().toISOString(),
					report_id: out.report_id,
					period: out.period,
					rows_returned: Math.min(rowsRaw.length, limit),
					baskets: rowsRaw.slice(0, limit),
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ============ BRAND ANALYTICS — REPEAT PURCHASE ============ */

	server.registerTool(
		"get_repeat_purchase",
		{
			description:
				"Repeat purchase behaviour per ASIN: unique customers, repeat customers and repeat purchase revenue. A consumable with no repeat rate is a warning about the product, not the marketing.",
			inputSchema: z.object({
				period: z.string().optional().describe("QUARTER, MONTH or WEEK. Default QUARTER."),
				period_start: z.string().optional().describe("Any date inside the wanted period."),
				max_rows: z.number().optional().describe("Rows to return. Default 100."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 80."),
			}),
		},
		async ({ period, period_start, max_rows, wait_seconds }: any) => {
			try {
				const p = (period || "QUARTER").toUpperCase();
				const wait = Math.max(5, Math.min(wait_seconds ?? 80, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 100, 500));

				const out = await runBrandAnalytics(
					"GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT",
					p,
					period_start,
					{},
					wait
				);

				if (!out.ok) return textResult(out);

				const d: any = out.data;
				const rowsRaw: any[] = Array.isArray(d) ? d : d.dataByAsin || [];

				return textResult({
					pulled_at: new Date().toISOString(),
					report_id: out.report_id,
					period: out.period,
					rows_returned: Math.min(rowsRaw.length, limit),
					repeat_purchase: rowsRaw.slice(0, limit),
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

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
				"Request any Amazon report and return it. Useful types: GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA (why customers returned items), GET_FBA_REIMBURSEMENTS_DATA (money Amazon owes for lost or damaged stock), GET_LEDGER_SUMMARY_VIEW_DATA (inventory movement), GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA (per-SKU fee estimates), GET_MERCHANT_LISTINGS_ALL_DATA. For any GET_BRAND_ANALYTICS_* report you MUST pass report_period (QUARTER, MONTH or WEEK) — prefer the dedicated get_top_search_terms and get_search_query_performance tools instead. Returns a report_id if Amazon needs longer.",
			inputSchema: z.object({
				report_type: z.string().describe("The Amazon report type, exactly as spelled above."),
				days: z.number().optional().describe("Days to look back. Default 30. Ignored for period reports."),
				wait_seconds: z.number().optional().describe("How long to wait. Default 55."),
				max_rows: z.number().optional().describe("Rows to return. Default 200."),
				report_period: z
					.string()
					.optional()
					.describe("QUARTER, MONTH or WEEK. REQUIRED for every GET_BRAND_ANALYTICS_* report."),
				period_start: z
					.string()
					.optional()
					.describe("Any date inside the wanted period, e.g. 2026-04-01. Omit for the last completed period."),
				report_options: z
					.string()
					.optional()
					.describe('Extra reportOptions as JSON, e.g. {"asin":"B0DS2V1TS6"}.'),
			}),
		},
		async ({ report_type, days, wait_seconds, max_rows, report_period, period_start, report_options }: any) => {
			try {
				const window = Math.max(1, days ?? 30);
				const wait = Math.max(5, Math.min(wait_seconds ?? 55, 110));
				const limit = Math.max(1, Math.min(max_rows ?? 200, 1000));

				let extra: any = {};
				if (report_options) {
					try {
						extra = JSON.parse(report_options);
					} catch {
						return textResult({ error: "report_options is not valid JSON", received: report_options });
					}
				}

				const needsPeriod = PERIOD_REPORTS.has(report_type);

				if (needsPeriod && !report_period) {
					return textResult({
						error: "REPORT_PERIOD_REQUIRED",
						report_type,
						message:
							"This report is built per calendar period. Pass report_period as QUARTER, MONTH or WEEK. Without it Amazon rejects the request at build time and returns a bare FATAL with no reason attached — which is exactly the failure v4 could not explain.",
					});
				}

				let result;
				if (needsPeriod) {
					const out = await runBrandAnalytics(report_type, report_period.toUpperCase(), period_start, extra, wait);
					return textResult(out);
				}

				result = await createAndWait(report_type, window, Object.keys(extra).length ? extra : undefined, wait);

				if (result.status === "REQUEST_REJECTED") {
					return textResult({
						status: result.status,
						report_type,
						amazon_message: result.rejectionMessage,
						sent_body: result.sentBody,
					});
				}

				if (result.status !== "DONE" || !result.documentId) {
					const why = await fatalReason(result.info);
					return textResult({
						report_id: result.reportId,
						report_type,
						status: result.status,
						amazon_detail: why,
						sent_body: result.sentBody,
						message:
							"Still building, or Amazon could not build it. Call get_report with this report_id shortly. A FATAL on a Brand Analytics report almost always means the refresh token predates the Brand Analytics role — re-Authorize and replace SP_REFRESH_TOKEN.",
					});
				}

				const raw = await downloadReportDocument(result.documentId);
				const trimmed = raw.trim();

				if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
					return textResult({
						pulled_at: new Date().toISOString(),
						report_type,
						report_id: result.reportId,
						format: "json",
						data: JSON.parse(trimmed),
					});
				}

				const rows = parseTSV(raw, limit);
				return textResult({
					pulled_at: new Date().toISOString(),
					report_type,
					report_id: result.reportId,
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
				"Fetch a report that was requested earlier, using the report_id returned by run_report, get_top_search_terms or get_traffic_and_conversion.",
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
					const why = await fatalReason(info);
					return textResult({
						report_id,
						status: info.processingStatus,
						report_type: info.reportType,
						amazon_detail: why,
						message:
							info.processingStatus === "FATAL"
								? "Amazon could not build this report. For a Brand Analytics type the usual cause is a refresh token issued before the Brand Analytics role was added — re-Authorize the app and replace SP_REFRESH_TOKEN. Otherwise check that the period is complete and published."
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
				"Referral and FBA fees for any ASIN at any price, before you ever list it. WARNING: Amazon returns the referral fee with a matching 'promotion' that nets it to zero, so the headline fee_percentage is understated by about 15 points. This tool adds the referral fee back and reports the TRUE total — use true_total_fees_pct for Gate 2, never fee_percentage.",
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

				// v5: undo Amazon's phantom referral-fee promotion.
				let referralGross = 0;
				let fbaFee = 0;
				for (const f of est.FeeDetailList || []) {
					const t = f.FeeType;
					if (t === "ReferralFee") referralGross += amountOf(f.FeeAmount);
					else if (t === "FBAFees" || t === "FulfillmentFees") fbaFee += amountOf(f.FinalFee);
				}

				const reportedTotal = amountOf(est.TotalFeesEstimate);
				const trueTotal = referralGross + fbaFee;
				const trueNet = price + (shipping ?? 0) - trueTotal;

				return textResult({
					pulled_at: new Date().toISOString(),
					asin,
					price_usd: money(price),
					status: result.Status,
					error: result.Error?.Message,

					amazon_reported_total_usd: money(reportedTotal),
					amazon_reported_pct: price ? ((reportedTotal / price) * 100).toFixed(1) + "%" : "0.0%",

					referral_fee_usd: money(referralGross),
					fba_fee_usd: money(fbaFee),
					true_total_fees_usd: money(trueTotal),
					true_total_fees_pct: price ? ((trueTotal / price) * 100).toFixed(1) + "%" : "0.0%",
					net_before_cogs_usd: money(trueNet),

					fee_breakdown: details,

					notes: [
						"USE true_total_fees_pct FOR GATE 2. Amazon zeroes the referral fee against a 'promotion' that does not exist for a normal seller; the headline percentage is therefore roughly 15 points too low.",
						"Gate 2 wants referral + FBA at or under 30% of price.",
						"This uses the dimensions of the ASIN passed in, so run it against a product the same size as the finished packed unit.",
					],
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
				"FBA inbound shipments and their status — what is on the way to Amazon, what has been received, and what is stuck.",
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

	/* ================= LISTING RESTRICTIONS ================= */

	server.registerTool(
		"get_listings_restrictions",
		{
			description:
				"Whether this account is allowed to list against a given ASIN, and if not, what approval is required. Run it BEFORE sourcing anything — a gated category found after the stock arrives is an expensive discovery.",
			inputSchema: z.object({
				asin: z.string().describe("The ASIN to test."),
				condition: z.string().optional().describe("Condition type. Default new_new."),
			}),
		},
		async ({ asin, condition }: any) => {
			try {
				const cond = condition || "new_new";
				const data = await spGet(
					"/listings/2021-08-01/restrictions?asin=" +
						encodeURIComponent(asin) +
						"&sellerId=" +
						SELLER_ID +
						"&marketplaceIds=" +
						MARKETPLACE_ID +
						"&conditionType=" +
						encodeURIComponent(cond)
				);

				const restrictions = data?.restrictions || [];

				return textResult({
					pulled_at: new Date().toISOString(),
					asin,
					condition: cond,
					restricted: restrictions.length > 0,
					restriction_count: restrictions.length,
					restrictions: restrictions.map((r: any) => ({
						marketplace: r.marketplaceId,
						condition: r.conditionType,
						reasons: (r.reasons || []).map((x: any) => ({
							message: x.message,
							reason_code: x.reasonCode,
							approval_links: (x.links || []).map((l: any) => l.resource),
						})),
					})),
					verdict:
						restrictions.length === 0
							? "OPEN — this account can list against this ASIN today."
							: "GATED — approval required before listing. Treat the category as closed unless the approval is realistic.",
				});
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

	/* ================================================================
	   AMAZON ADS — Sponsored Products (ADS v1, 29 Sep 2026)
	   Reads run freely. Writes preview first; confirm = true applies.
	   ================================================================ */

	server.registerTool(
		"ads_list_profiles",
		{
			description:
				"Amazon Ads: lists the advertising profiles this account can reach and shows which one the tools use (the US seller profile), plus the guardrail limits in force (bid cap, daily budget ceiling). Run this first to confirm the Ads connection works.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const profiles = await listAdsProfiles();
				const using = await getAdsProfileId();
				const { maxBid, maxDailyBudget } = adsLimits();
				return textResult({
					using_profile: using,
					profiles: profiles.map((p) => ({
						profileId: p.profileId,
						country: p.countryCode,
						currency: p.currencyCode,
						type: p.accountInfo?.type,
						name: p.accountInfo?.name,
					})),
					guardrails: switchesSummary(),
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_account_overview",
		{
			description:
				"Amazon Ads: every Sponsored Products campaign (state, daily budget, bidding strategy), its ad groups (default bid), advertised SKUs, keywords (text, match type, bid, state), product/auto targets, and negative keywords and targets (ad-group and campaign level). Archived items are hidden. Optionally limit to one campaign_id. Use it before any change, and to see current bids.",
			inputSchema: z.object({
				campaign_id: z.string().optional().describe("Only this campaign."),
			}),
		},
		async ({ campaign_id }: any) => {
			try {
				const byCampaign = campaign_id ? { campaignIdFilter: { include: [String(campaign_id)] } } : {};
				const [campaigns, adGroups, productAds, keywords, negatives] = await Promise.all([
					adsList("/sp/campaigns/list", ADS_TYPE.campaign, "campaigns", { stateFilter: LIVE_STATES, ...byCampaign }),
					adsList("/sp/adGroups/list", ADS_TYPE.adGroup, "adGroups", { stateFilter: LIVE_STATES, ...byCampaign }),
					adsList("/sp/productAds/list", ADS_TYPE.productAd, "productAds", { stateFilter: LIVE_STATES, ...byCampaign }),
					adsList("/sp/keywords/list", ADS_TYPE.keyword, "keywords", { stateFilter: LIVE_STATES, ...byCampaign }),
					adsList("/sp/negativeKeywords/list", ADS_TYPE.negativeKeyword, "negativeKeywords", {
						stateFilter: LIVE_STATES,
						...byCampaign,
					}),
				]);
				const optional = async (p: Promise<any[]>) => {
					try {
						return await p;
					} catch {
						return [] as any[];
					}
				};
				const [targets, campaignNegatives, negativeTargets] = await Promise.all([
					optional(adsList("/sp/targets/list", ADS_TYPE.target, "targetingClauses", { stateFilter: LIVE_STATES, ...byCampaign })),
					optional(adsList("/sp/campaignNegativeKeywords/list", ADS_TYPE.campaignNegativeKeyword, "campaignNegativeKeywords", { stateFilter: LIVE_STATES, ...byCampaign })),
					optional(adsList("/sp/negativeTargets/list", ADS_TYPE.negativeTarget, "negativeTargetingClauses", { stateFilter: LIVE_STATES, ...byCampaign })),
				]);
				const { maxBid, maxDailyBudget } = adsLimits();

				return textResult({
					guardrails: switchesSummary(),
					campaigns: campaigns.map((c) => ({
						campaignId: c.campaignId,
						name: c.name,
						state: c.state,
						targeting: c.targetingType,
						daily_budget: c.budget?.budget,
						bidding: c.dynamicBidding?.strategy,
						startDate: c.startDate,
						ad_groups: adGroups
							.filter((g) => g.campaignId === c.campaignId)
							.map((g) => ({
								adGroupId: g.adGroupId,
								name: g.name,
								state: g.state,
								default_bid: g.defaultBid,
								skus: productAds
									.filter((a) => a.adGroupId === g.adGroupId)
									.map((a) => ({ adId: a.adId, sku: a.sku, asin: a.asin, state: a.state })),
								keywords: keywords
									.filter((k) => k.adGroupId === g.adGroupId)
									.map((k) => ({
										keywordId: k.keywordId,
										text: k.keywordText,
										match: k.matchType,
										bid: k.bid ?? g.defaultBid,
										state: k.state,
										over_cap: Number(k.bid ?? g.defaultBid) > maxBid ? "YES — lower it" : undefined,
									})),
								product_and_auto_targets: targets
									.filter((t) => t.adGroupId === g.adGroupId)
									.map((t) => ({
										targetId: t.targetId,
										expression: (t.expression || []).map((x: any) => x.type + (x.value ? ": " + x.value : "")).join(" + "),
										bid: t.bid ?? g.defaultBid,
										state: t.state,
									})),
							})),
						negatives: negatives
							.filter((n) => n.campaignId === c.campaignId)
							.map((n) => ({ keywordId: n.keywordId, text: n.keywordText, match: n.matchType, adGroupId: n.adGroupId }))
							.concat(
								campaignNegatives
									.filter((n) => n.campaignId === c.campaignId)
									.map((n) => ({ keywordId: n.keywordId, text: n.keywordText, match: n.matchType, adGroupId: "campaign level" }))
							),
						negative_product_targets: negativeTargets
							.filter((n) => n.campaignId === c.campaignId)
							.map((n) => ({ targetId: n.targetId, expression: (n.expression || []).map((x: any) => x.type + ": " + x.value).join(" + ") })),
						not_exact_only: c.targetingType !== "MANUAL" ? "AUTO campaign — breaks the exact-only rule" : undefined,
					})),
					counts: {
						campaigns: campaigns.length,
						ad_groups: adGroups.length,
						keywords: keywords.length,
						negatives: negatives.length + campaignNegatives.length,
						product_and_auto_targets: targets.length,
						negative_product_targets: negativeTargets.length,
					},
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_request_report",
		{
			description:
				"Amazon Ads performance report — every report type except DSP. Sponsored Products: campaigns | campaigns_daily | ad_groups | placements (top of search vs rest) | keywords | search_terms | advertised_products | purchased_products (halo sales of other ASINs). Sponsored Brands: sb_campaigns | sb_search_terms. Sponsored Display: sd_campaigns | sd_targeting. Returns spend, clicks, orders, sales, ACOS, CPC and CVR per row with totals, and FLAGS rows to act on: PAUSE (86+ clicks, <3 orders), WATCH (10+ clicks, 0 orders — negative candidate), HARVEST (search term with 2+ orders not yet an exact keyword). Amazon builds reports asynchronously: if it is not ready within wait_seconds you get a report_id — call ads_get_report with it later. Max 31 days per report. Amazon keeps only about 95 days of report data (older dates are refused), so save monthly reports.",
			inputSchema: z.object({
				kind: z.enum(ADS_REPORT_KINDS),
				start_date: z.string().optional().describe("YYYY-MM-DD. Default 30 days ago."),
				end_date: z.string().optional().describe("YYYY-MM-DD. Default yesterday."),
				wait_seconds: z.number().optional().describe("Default 60, max 100."),
			}),
		},
		async ({ kind, start_date, end_date, wait_seconds }: any) => {
			try {
				const end = end_date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
				const start = start_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
				const span = (Date.parse(end) - Date.parse(start)) / 86400000;
				if (!(span >= 0)) return errorResult(new Error("start_date must be on or before end_date (YYYY-MM-DD)."));
				if (span > 30) return errorResult(new Error("Amazon allows at most 31 days per report. Split the range."));

				const created = await adsCreateReport(kind, start, end);
				const wait = Math.max(5, Math.min(wait_seconds ?? 60, 100));
				const result = await adsFetchReport(created.reportId, kind, wait);
				return textResult({
					start_date: start,
					end_date: end,
					...(created.dropped_columns?.length ? { columns_amazon_refused: created.dropped_columns } : {}),
					...result,
				});
			} catch (e: any) {
				const m = String(e?.message || e);
				const dup = m.match(/duplicate of\s*:?\s*([0-9a-f-]{36})/i);
				if (dup) {
					return textResult({
						note: "Amazon already has this exact report. Use ads_get_report with this id.",
						report_id: dup[1],
					});
				}
				const ret = m.match(/retention start date \(?(\d{4}-\d{2}-\d{2})/i);
				if (ret) {
					return textResult({
						status: "REFUSED — too old",
						note: "Amazon only keeps this report type from " + ret[1] + ". Use a start_date on or after that date. Older history exists only in manual exports from the Ads console.",
					});
				}
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_get_report",
		{
			description:
				"Fetch an Amazon Ads report started earlier by ads_request_report. Pass the report_id and the same kind.",
			inputSchema: z.object({
				report_id: z.string(),
				kind: z.enum(ADS_REPORT_KINDS),
				wait_seconds: z.number().optional().describe("Default 30, max 100."),
			}),
		},
		async ({ report_id, kind, wait_seconds }: any) => {
			try {
				const wait = Math.max(0, Math.min(wait_seconds ?? 30, 100));
				return textResult(await adsFetchReport(report_id, kind, wait));
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================================================================
	   WRITE TOOLS — ADS v3 (Sponsored Products full control)
	   Every write: preview unless confirm = true. Money limits always on;
	   rule limits are switches in Cloudflare (see adsLimits()).
	   ================================================================ */

	const matchSchema = z.enum(["EXACT", "PHRASE", "BROAD"]).optional();
	const placementSchema = z
		.object({
			top_of_search: z.number().optional(),
			product_pages: z.number().optional(),
			rest_of_search: z.number().optional(),
		})
		.optional()
		.describe("Placement bid boosts in percent (0 = none). Blocked unless ADS_MAX_PLACEMENT_PERCENT is set.");

	const checkMatch = (m: string, problems: string[]) => {
		const { allowedMatch } = adsLimits();
		if (!allowedMatch.includes(m)) problems.push("Match type " + m + " is blocked (allowed: " + allowedMatch.join(", ") + "; switch ADS_ALLOWED_MATCH_TYPES).");
	};
	const checkBudget = (b: number | undefined, problems: string[]) => {
		const { maxDailyBudget } = adsLimits();
		if (b !== undefined && (!(b >= 1) || b > maxDailyBudget))
			problems.push("daily_budget $" + money(Number(b)) + " must be $1.00–$" + money(maxDailyBudget) + " (ADS_MAX_DAILY_BUDGET).");
	};
	const checkBid = (label: string, bid: number | undefined, current: number | undefined, problems: string[]) => {
		if (bid === undefined) return;
		const { maxBid, allowBidIncrease } = adsLimits();
		if (!(bid >= 0.02)) problems.push(label + " bid $" + money(Number(bid)) + " is below Amazon's $0.02 minimum.");
		if (bid > maxBid) problems.push(label + " bid $" + money(bid) + " is above the $" + money(maxBid) + " cap (ADS_MAX_BID).");
		if (current !== undefined && Number.isFinite(current) && bid > current && !allowBidIncrease)
			problems.push(label + " $" + money(current) + " → $" + money(bid) + " is an INCREASE (blocked; switch ADS_ALLOW_BID_INCREASE).");
	};
	const placementBidding = (p: any, problems: string[]) => {
		if (!p) return undefined;
		const { maxPlacementPercent } = adsLimits();
		const rows = [
			["PLACEMENT_TOP", p.top_of_search],
			["PLACEMENT_PRODUCT_PAGE", p.product_pages],
			["PLACEMENT_REST_OF_SEARCH", p.rest_of_search],
		].filter(([, v]) => v !== undefined) as [string, number][];
		for (const [k, v] of rows) {
			if (!(v >= 0) || v > maxPlacementPercent)
				problems.push(k + " " + v + "% must be 0–" + maxPlacementPercent + "% (ADS_MAX_PLACEMENT_PERCENT).");
		}
		return rows.map(([placement, percentage]) => ({ placement, percentage: Math.round(percentage) }));
	};
	const strategyOk = (s: string | undefined, problems: string[]) => {
		if (!s) return;
		const { allowBidIncrease } = adsLimits();
		if (s !== "LEGACY_FOR_SALES" && !allowBidIncrease)
			problems.push("Bidding " + s + " can raise bids (blocked; only LEGACY_FOR_SALES = down only, unless ADS_ALLOW_BID_INCREASE).");
	};
	const previewOrRun = async (confirm: boolean | undefined, problems: string[], plan: any, run: () => Promise<any>) => {
		if (problems.length) return textResult({ status: "REJECTED — nothing changed", problems, plan, switches: switchesSummary() });
		if (!confirm) return textResult({ status: "PREVIEW — nothing changed. Call again with confirm = true.", plan });
		return textResult({ status: "DONE", plan, result: await run() });
	};
	const currentKeywords = async (ids: string[]) => {
		const kws = await adsList("/sp/keywords/list", ADS_TYPE.keyword, "keywords", { keywordIdFilter: { include: ids } });
		const groups = kws.length
			? await adsList("/sp/adGroups/list", ADS_TYPE.adGroup, "adGroups", {
					adGroupIdFilter: { include: [...new Set(kws.map((k: any) => String(k.adGroupId)))] },
				})
			: [];
		const gBid = new Map(groups.map((g: any) => [String(g.adGroupId), Number(g.defaultBid)]));
		return new Map(kws.map((k: any) => [String(k.keywordId), { ...k, effectiveBid: Number(k.bid ?? gBid.get(String(k.adGroupId))) }]));
	};

	server.registerTool(
		"ads_switches",
		{
			description: "Shows the rule switches and money limits currently in force for all Ads write tools, and how to change each one in Cloudflare.",
			inputSchema: z.object({}),
		},
		async () => textResult(switchesSummary())
	);

	server.registerTool(
		"ads_create_exact_campaign",
		{
			description:
				"WRITE. Builds a Sponsored Products campaign in one step: campaign (created PAUSED), one ad group, the SKU(s) as product ads, and keywords (EXACT by default; other match types only if switched on). Optional AUTO campaign (switch ADS_ALLOW_AUTO), bidding strategy (default 'down only') and placement boosts (switch). Bids ≤ cap, budget ≤ ceiling. Preview unless confirm = true. Turning it on is a separate ads_update_campaign call — Adnan's decision.",
			inputSchema: z.object({
				campaign_name: z.string(),
				sku: z.string().describe("Seller SKU to advertise."),
				extra_skus: z.array(z.string()).optional(),
				daily_budget: z.number(),
				default_bid: z.number(),
				targeting: z.enum(["MANUAL", "AUTO"]).optional().describe("Default MANUAL."),
				match_type: matchSchema.describe("For all keywords. Default EXACT."),
				keywords: z.array(z.object({ text: z.string(), bid: z.number().optional() })).max(200).optional(),
				bidding_strategy: z.enum(["LEGACY_FOR_SALES", "AUTO_FOR_SALES", "MANUAL"]).optional(),
				placements: placementSchema,
				end_date: z.string().optional().describe("YYYY-MM-DD"),
				confirm: z.boolean().optional(),
			}),
		},
		async (a: any) => {
			try {
				const { allowAuto } = adsLimits();
				const problems: string[] = [];
				const targeting = a.targeting || "MANUAL";
				const match = a.match_type || "EXACT";
				const strategy = a.bidding_strategy || "LEGACY_FOR_SALES";
				if (targeting === "AUTO" && !allowAuto) problems.push("AUTO campaigns are blocked (switch ADS_ALLOW_AUTO).");
				if (targeting === "MANUAL" && !(a.keywords?.length)) problems.push("A MANUAL campaign needs keywords.");
				checkBudget(a.daily_budget, problems);
				checkBid("default", a.default_bid, undefined, problems);
				strategyOk(strategy, problems);
				const kws = (a.keywords || []).map((k: any) => ({ text: cleanKeyword(k.text), bid: Number(k.bid ?? a.default_bid) }));
				if (kws.length) {
					checkMatch(match, problems);
					problems.push(...checkNewKeywords(kws, adsLimits().maxBid));
				}
				const pb = placementBidding(a.placements, problems);
				const skus = [a.sku, ...(a.extra_skus || [])].map((s: string) => String(s).trim()).filter(Boolean);

				const plan = {
					campaign: { name: a.campaign_name, targeting, state: "PAUSED", daily_budget: money(a.daily_budget), bidding: strategy, placements: pb, end_date: a.end_date },
					ad_group: { name: a.campaign_name + " - " + (targeting === "AUTO" ? "auto" : match.toLowerCase()), default_bid: money(a.default_bid) },
					skus,
					keywords: kws.map((k: any) => ({ text: k.text, match, bid: money(k.bid) })),
				};
				return await previewOrRun(a.confirm, problems, plan, async () => {
					const camp: any = {
						name: a.campaign_name,
						targetingType: targeting,
						state: "PAUSED",
						startDate: todayISODate(),
						budget: { budgetType: "DAILY", budget: Number(a.daily_budget) },
						dynamicBidding: { strategy, ...(pb?.length ? { placementBidding: pb } : {}) },
					};
					if (a.end_date) camp.endDate = a.end_date;
					const c = adsWriteResult(await adsRequest("POST", "/sp/campaigns", { type: ADS_TYPE.campaign, body: { campaigns: [camp] } }), "campaigns");
					if (!c.success.length) return { failed_at: "campaign", errors: c.error };
					const campaignId = c.success[0].campaignId;
					const g = adsWriteResult(
						await adsRequest("POST", "/sp/adGroups", {
							type: ADS_TYPE.adGroup,
							body: { adGroups: [{ campaignId, name: plan.ad_group.name, defaultBid: Number(a.default_bid), state: "ENABLED" }] },
						}),
						"adGroups"
					);
					if (!g.success.length) return { campaignId, failed_at: "ad group (campaign exists, PAUSED)", errors: g.error };
					const adGroupId = g.success[0].adGroupId;
					const ads = adsWriteResult(
						await adsRequest("POST", "/sp/productAds", {
							type: ADS_TYPE.productAd,
							body: { productAds: skus.map((sku) => ({ campaignId, adGroupId, sku, state: "ENABLED" })) },
						}),
						"productAds"
					);
					let kw: any = { success: [], error: [] };
					if (kws.length) {
						kw = adsWriteResult(
							await adsRequest("POST", "/sp/keywords", {
								type: ADS_TYPE.keyword,
								body: { keywords: kws.map((k: any) => ({ campaignId, adGroupId, keywordText: k.text, matchType: match, bid: k.bid, state: "ENABLED" })) },
							}),
							"keywords"
						);
					}
					return {
						campaignId,
						adGroupId,
						state: "PAUSED — no spend until enabled",
						product_ads_added: ads.success.length,
						product_ad_errors: ads.error.length ? ads.error : undefined,
						keywords_added: kw.success.length,
						keyword_errors: kw.error.length ? kw.error : undefined,
					};
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_campaign",
		{
			description:
				"WRITE. Changes a Sponsored Products campaign: state (ENABLED starts spend, PAUSED stops it), daily budget (≤ ceiling), name, end date, bidding strategy ('down only' unless switch) and placement boosts (switch). Enabling spends money — only when Adnan approves. Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				state: z.enum(["ENABLED", "PAUSED"]).optional(),
				daily_budget: z.number().optional(),
				name: z.string().optional(),
				end_date: z.string().optional().describe("YYYY-MM-DD, or 'none' to remove."),
				bidding_strategy: z.enum(["LEGACY_FOR_SALES", "AUTO_FOR_SALES", "MANUAL"]).optional(),
				placements: placementSchema,
				confirm: z.boolean().optional(),
			}),
		},
		async (a: any) => {
			try {
				const { allowAuto } = adsLimits();
				const [c] = await adsList("/sp/campaigns/list", ADS_TYPE.campaign, "campaigns", { campaignIdFilter: { include: [String(a.campaign_id)] } });
				if (!c) return errorResult(new Error("Campaign " + a.campaign_id + " not found."));
				const problems: string[] = [];
				checkBudget(a.daily_budget, problems);
				strategyOk(a.bidding_strategy, problems);
				const pb = placementBidding(a.placements, problems);
				if (a.state === "ENABLED" && c.targetingType === "AUTO" && !allowAuto) problems.push("This is an AUTO campaign (blocked; switch ADS_ALLOW_AUTO).");
				if (a.state === "ENABLED" && c.dynamicBidding?.strategy && c.dynamicBidding.strategy !== "LEGACY_FOR_SALES" && !a.bidding_strategy)
					strategyOk(c.dynamicBidding.strategy, problems);
				if (a.state === "ENABLED" && Number(c.budget?.budget) > adsLimits().maxDailyBudget && a.daily_budget === undefined)
					problems.push("Current budget $" + money(Number(c.budget?.budget)) + " is above the ceiling — set daily_budget in the same call.");
				const changes = ["state", "daily_budget", "name", "end_date", "bidding_strategy", "placements"].filter((k) => a[k] !== undefined);
				if (!changes.length) problems.push("Nothing to change.");

				const plan: any = { campaign: c.name, changes: {} };
				if (a.state) plan.changes.state = c.state + " → " + a.state;
				if (a.daily_budget !== undefined) plan.changes.budget = money(Number(c.budget?.budget)) + " → " + money(a.daily_budget);
				if (a.name) plan.changes.name = c.name + " → " + a.name;
				if (a.end_date) plan.changes.end_date = (c.endDate || "none") + " → " + a.end_date;
				if (a.bidding_strategy) plan.changes.bidding = (c.dynamicBidding?.strategy || "?") + " → " + a.bidding_strategy;
				if (pb) plan.changes.placements = pb;

				return await previewOrRun(a.confirm, problems, plan, async () => {
					const x: any = { campaignId: String(a.campaign_id) };
					if (a.state) x.state = a.state;
					if (a.daily_budget !== undefined) x.budget = { budgetType: "DAILY", budget: Number(a.daily_budget) };
					if (a.name) x.name = a.name;
					if (a.end_date) x.endDate = a.end_date === "none" ? null : a.end_date;
					if (a.bidding_strategy || pb) {
						x.dynamicBidding = {
							strategy: a.bidding_strategy || c.dynamicBidding?.strategy || "LEGACY_FOR_SALES",
							placementBidding: pb ?? c.dynamicBidding?.placementBidding ?? [],
						};
					}
					return adsWriteResult(await adsRequest("PUT", "/sp/campaigns", { type: ADS_TYPE.campaign, body: { campaigns: [x] } }), "campaigns");
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_ad_group",
		{
			description:
				"WRITE. Changes an ad group's default bid (≤ cap; increases need the switch), state (ENABLED/PAUSED) or name. Preview unless confirm = true.",
			inputSchema: z.object({
				ad_group_id: z.string(),
				default_bid: z.number().optional(),
				state: z.enum(["ENABLED", "PAUSED"]).optional(),
				name: z.string().optional(),
				confirm: z.boolean().optional(),
			}),
		},
		async (a: any) => {
			try {
				const [g] = await adsList("/sp/adGroups/list", ADS_TYPE.adGroup, "adGroups", { adGroupIdFilter: { include: [String(a.ad_group_id)] } });
				if (!g) return errorResult(new Error("Ad group " + a.ad_group_id + " not found."));
				const problems: string[] = [];
				checkBid("default", a.default_bid, Number(g.defaultBid), problems);
				if (a.default_bid === undefined && !a.state && !a.name) problems.push("Nothing to change.");
				const plan: any = { ad_group: g.name, changes: {} };
				if (a.default_bid !== undefined) plan.changes.default_bid = money(Number(g.defaultBid)) + " → " + money(a.default_bid);
				if (a.state) plan.changes.state = g.state + " → " + a.state;
				if (a.name) plan.changes.name = g.name + " → " + a.name;
				return await previewOrRun(a.confirm, problems, plan, async () => {
					const x: any = { adGroupId: String(a.ad_group_id) };
					if (a.default_bid !== undefined) x.defaultBid = Number(a.default_bid);
					if (a.state) x.state = a.state;
					if (a.name) x.name = a.name;
					return adsWriteResult(await adsRequest("PUT", "/sp/adGroups", { type: ADS_TYPE.adGroup, body: { adGroups: [x] } }), "adGroups");
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_ad_group",
		{
			description:
				"WRITE. Adds a new ad group (with SKUs and keywords) inside an existing campaign — e.g. a separate group for a second keyword set. Same checks as campaign creation. Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				name: z.string(),
				default_bid: z.number(),
				skus: z.array(z.string()).min(1),
				match_type: matchSchema,
				keywords: z.array(z.object({ text: z.string(), bid: z.number().optional() })).max(200).optional(),
				confirm: z.boolean().optional(),
			}),
		},
		async (a: any) => {
			try {
				const problems: string[] = [];
				const match = a.match_type || "EXACT";
				checkBid("default", a.default_bid, undefined, problems);
				const kws = (a.keywords || []).map((k: any) => ({ text: cleanKeyword(k.text), bid: Number(k.bid ?? a.default_bid) }));
				if (kws.length) {
					checkMatch(match, problems);
					problems.push(...checkNewKeywords(kws, adsLimits().maxBid));
				}
				const plan = { campaign_id: a.campaign_id, ad_group: a.name, default_bid: money(a.default_bid), skus: a.skus, keywords: kws.map((k: any) => ({ text: k.text, match, bid: money(k.bid) })) };
				return await previewOrRun(a.confirm, problems, plan, async () => {
					const campaignId = String(a.campaign_id);
					const g = adsWriteResult(
						await adsRequest("POST", "/sp/adGroups", { type: ADS_TYPE.adGroup, body: { adGroups: [{ campaignId, name: a.name, defaultBid: Number(a.default_bid), state: "ENABLED" }] } }),
						"adGroups"
					);
					if (!g.success.length) return { failed_at: "ad group", errors: g.error };
					const adGroupId = g.success[0].adGroupId;
					const ads = adsWriteResult(
						await adsRequest("POST", "/sp/productAds", { type: ADS_TYPE.productAd, body: { productAds: a.skus.map((sku: string) => ({ campaignId, adGroupId, sku: String(sku).trim(), state: "ENABLED" })) } }),
						"productAds"
					);
					let kw: any = { success: [], error: [] };
					if (kws.length)
						kw = adsWriteResult(
							await adsRequest("POST", "/sp/keywords", { type: ADS_TYPE.keyword, body: { keywords: kws.map((k: any) => ({ campaignId, adGroupId, keywordText: k.text, matchType: match, bid: k.bid, state: "ENABLED" })) } }),
							"keywords"
						);
					return { adGroupId, product_ads_added: ads.success.length, product_ad_errors: ads.error, keywords_added: kw.success.length, keyword_errors: kw.error };
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_exact_keywords",
		{
			description:
				"WRITE. Adds keywords to an existing ad group (e.g. harvested search terms). EXACT by default; PHRASE/BROAD only if switched on. Each bid ≤ cap. Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				ad_group_id: z.string(),
				keywords: z.array(z.object({ text: z.string(), bid: z.number() })).min(1).max(200),
				match_type: matchSchema,
				confirm: z.boolean().optional(),
			}),
		},
		async (a: any) => {
			try {
				const match = a.match_type || "EXACT";
				const kws = a.keywords.map((k: any) => ({ text: cleanKeyword(k.text), bid: Number(k.bid) }));
				const problems = checkNewKeywords(kws, adsLimits().maxBid);
				checkMatch(match, problems);
				const plan = kws.map((k: any) => ({ text: k.text, match, bid: money(k.bid) }));
				return await previewOrRun(a.confirm, problems, plan, async () =>
					adsWriteResult(
						await adsRequest("POST", "/sp/keywords", {
							type: ADS_TYPE.keyword,
							body: { keywords: kws.map((k: any) => ({ campaignId: String(a.campaign_id), adGroupId: String(a.ad_group_id), keywordText: k.text, matchType: match, bid: k.bid, state: "ENABLED" })) },
						}),
						"keywords"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_keywords",
		{
			description:
				"WRITE. Changes keyword bids and/or state (ENABLED/PAUSED). Bids only go DOWN unless ADS_ALLOW_BID_INCREASE is on, and never above the cap. Preview shows current → new. To delete, use ads_archive.",
			inputSchema: z.object({
				updates: z.array(z.object({ keyword_id: z.string(), bid: z.number().optional(), state: z.enum(["ENABLED", "PAUSED"]).optional() })).min(1).max(200),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ updates, confirm }: any) => {
			try {
				const cur = await currentKeywords(updates.map((u: any) => String(u.keyword_id)));
				const problems: string[] = [];
				const plan = updates.map((u: any) => {
					const k: any = cur.get(String(u.keyword_id));
					if (!k) {
						problems.push("Keyword " + u.keyword_id + " not found.");
						return { keyword_id: u.keyword_id };
					}
					checkBid('"' + k.keywordText + '"', u.bid, k.effectiveBid, problems);
					if (u.bid === undefined && !u.state) problems.push('"' + k.keywordText + '" has no change.');
					return {
						keyword_id: u.keyword_id,
						text: k.keywordText,
						match: k.matchType,
						bid: u.bid !== undefined ? money(k.effectiveBid) + " → " + money(u.bid) : money(k.effectiveBid) + " (unchanged)",
						state: u.state ? k.state + " → " + u.state : k.state,
					};
				});
				return await previewOrRun(confirm, problems, plan, async () =>
					adsWriteResult(
						await adsRequest("PUT", "/sp/keywords", {
							type: ADS_TYPE.keyword,
							body: {
								keywords: updates.map((u: any) => {
									const x: any = { keywordId: String(u.keyword_id) };
									if (u.bid !== undefined) x.bid = Number(u.bid);
									if (u.state) x.state = u.state;
									return x;
								}),
							},
						}),
						"keywords"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_negative_keywords",
		{
			description:
				"WRITE. Adds negative keywords (NEGATIVE_EXACT default, or NEGATIVE_PHRASE). Give ad_group_id for ad-group level, or leave it out for campaign level (blocks the term in every ad group). Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				ad_group_id: z.string().optional(),
				keywords: z.array(z.string()).min(1).max(200),
				match_type: z.enum(["NEGATIVE_EXACT", "NEGATIVE_PHRASE"]).optional(),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ campaign_id, ad_group_id, keywords, match_type, confirm }: any) => {
			try {
				const match = match_type || "NEGATIVE_EXACT";
				const kws = [...new Set(keywords.map(cleanKeyword).filter(Boolean))] as string[];
				const level = ad_group_id ? "ad group " + ad_group_id : "campaign level";
				const plan = kws.map((t) => ({ text: t, match, level }));
				return await previewOrRun(confirm, [], plan, async () => {
					if (ad_group_id) {
						return adsWriteResult(
							await adsRequest("POST", "/sp/negativeKeywords", {
								type: ADS_TYPE.negativeKeyword,
								body: { negativeKeywords: kws.map((t) => ({ campaignId: String(campaign_id), adGroupId: String(ad_group_id), keywordText: t, matchType: match, state: "ENABLED" })) },
							}),
							"negativeKeywords"
						);
					}
					return adsWriteResult(
						await adsRequest("POST", "/sp/campaignNegativeKeywords", {
							type: ADS_TYPE.campaignNegativeKeyword,
							body: { campaignNegativeKeywords: kws.map((t) => ({ campaignId: String(campaign_id), keywordText: t, matchType: match, state: "ENABLED" })) },
						}),
						"campaignNegativeKeywords"
					);
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_product_targets",
		{
			description:
				"WRITE. Targets competitor product pages (ASIN) or a category in a MANUAL ad group. Blocked unless ADS_ALLOW_PRODUCT_TARGETING=true. Each bid ≤ cap. Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				ad_group_id: z.string(),
				targets: z
					.array(z.object({ asin: z.string().optional(), category_id: z.string().optional(), bid: z.number() }))
					.min(1)
					.max(100),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ campaign_id, ad_group_id, targets, confirm }: any) => {
			try {
				const { allowProductTargeting } = adsLimits();
				const problems: string[] = [];
				if (!allowProductTargeting) problems.push("Product targeting is blocked (switch ADS_ALLOW_PRODUCT_TARGETING).");
				const clauses = targets.map((t: any) => {
					if (!t.asin && !t.category_id) problems.push("Each target needs asin or category_id.");
					checkBid(t.asin || t.category_id, t.bid, undefined, problems);
					return {
						campaignId: String(campaign_id),
						adGroupId: String(ad_group_id),
						expressionType: "MANUAL",
						expression: [t.asin ? { type: "ASIN_SAME_AS", value: String(t.asin).trim().toUpperCase() } : { type: "ASIN_CATEGORY_SAME_AS", value: String(t.category_id) }],
						bid: Number(t.bid),
						state: "ENABLED",
					};
				});
				const plan = clauses.map((c: any) => ({ target: c.expression[0].type + ": " + c.expression[0].value, bid: money(c.bid) }));
				return await previewOrRun(confirm, problems, plan, async () =>
					adsWriteResult(await adsRequest("POST", "/sp/targets", { type: ADS_TYPE.target, body: { targetingClauses: clauses } }), "targetingClauses")
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_targets",
		{
			description:
				"WRITE. Changes bids or state of product targets and AUTO-campaign target groups (close match, loose match, substitutes, complements). Same bid rules as keywords. Preview unless confirm = true.",
			inputSchema: z.object({
				updates: z.array(z.object({ target_id: z.string(), bid: z.number().optional(), state: z.enum(["ENABLED", "PAUSED"]).optional() })).min(1).max(100),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ updates, confirm }: any) => {
			try {
				const cur = await adsList("/sp/targets/list", ADS_TYPE.target, "targetingClauses", { targetIdFilter: { include: updates.map((u: any) => String(u.target_id)) } });
				const byId = new Map(cur.map((t: any) => [String(t.targetId), t]));
				const problems: string[] = [];
				const plan = updates.map((u: any) => {
					const t: any = byId.get(String(u.target_id));
					if (!t) {
						problems.push("Target " + u.target_id + " not found.");
						return { target_id: u.target_id };
					}
					const label = (t.expression || []).map((x: any) => x.type + (x.value ? ": " + x.value : "")).join(" + ");
					checkBid(label, u.bid, t.bid !== undefined ? Number(t.bid) : undefined, problems);
					return { target_id: u.target_id, target: label, bid: u.bid !== undefined ? (t.bid ?? "default") + " → " + money(u.bid) : "unchanged", state: u.state ? t.state + " → " + u.state : t.state };
				});
				return await previewOrRun(confirm, problems, plan, async () =>
					adsWriteResult(
						await adsRequest("PUT", "/sp/targets", {
							type: ADS_TYPE.target,
							body: {
								targetingClauses: updates.map((u: any) => {
									const x: any = { targetId: String(u.target_id) };
									if (u.bid !== undefined) x.bid = Number(u.bid);
									if (u.state) x.state = u.state;
									return x;
								}),
							},
						}),
						"targetingClauses"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_negative_product_targets",
		{
			description:
				"WRITE. Stops ads showing on specific product pages (negative ASIN targets) — e.g. your own listings or pages that waste clicks. Preview unless confirm = true.",
			inputSchema: z.object({
				campaign_id: z.string(),
				ad_group_id: z.string(),
				asins: z.array(z.string()).min(1).max(100),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ campaign_id, ad_group_id, asins, confirm }: any) => {
			try {
				const list = [...new Set(asins.map((x: string) => String(x).trim().toUpperCase()))] as string[];
				return await previewOrRun(confirm, [], list.map((x) => ({ negative_asin: x })), async () =>
					adsWriteResult(
						await adsRequest("POST", "/sp/negativeTargets", {
							type: ADS_TYPE.negativeTarget,
							body: { negativeTargetingClauses: list.map((x) => ({ campaignId: String(campaign_id), adGroupId: String(ad_group_id), expression: [{ type: "ASIN_SAME_AS", value: x }], state: "ENABLED" })) },
						}),
						"negativeTargetingClauses"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_add_product_ads",
		{
			description: "WRITE. Adds SKUs to an existing ad group. Preview unless confirm = true.",
			inputSchema: z.object({ campaign_id: z.string(), ad_group_id: z.string(), skus: z.array(z.string()).min(1).max(50), confirm: z.boolean().optional() }),
		},
		async ({ campaign_id, ad_group_id, skus, confirm }: any) => {
			try {
				const list = skus.map((s: string) => String(s).trim()).filter(Boolean);
				return await previewOrRun(confirm, [], { ad_group_id, skus: list }, async () =>
					adsWriteResult(
						await adsRequest("POST", "/sp/productAds", {
							type: ADS_TYPE.productAd,
							body: { productAds: list.map((sku: string) => ({ campaignId: String(campaign_id), adGroupId: String(ad_group_id), sku, state: "ENABLED" })) },
						}),
						"productAds"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_product_ads",
		{
			description: "WRITE. Pauses or re-enables advertised SKUs (product ads) by ad_id. Preview unless confirm = true.",
			inputSchema: z.object({
				updates: z.array(z.object({ ad_id: z.string(), state: z.enum(["ENABLED", "PAUSED"]) })).min(1).max(100),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ updates, confirm }: any) => {
			try {
				return await previewOrRun(confirm, [], updates, async () =>
					adsWriteResult(
						await adsRequest("PUT", "/sp/productAds", {
							type: ADS_TYPE.productAd,
							body: { productAds: updates.map((u: any) => ({ adId: String(u.ad_id), state: u.state })) },
						}),
						"productAds"
					)
				);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	const ARCHIVE_MAP: Record<string, { path: string; type: string; filter: string; key: string }> = {
		campaign: { path: "/sp/campaigns/delete", type: ADS_TYPE.campaign, filter: "campaignIdFilter", key: "campaigns" },
		ad_group: { path: "/sp/adGroups/delete", type: ADS_TYPE.adGroup, filter: "adGroupIdFilter", key: "adGroups" },
		keyword: { path: "/sp/keywords/delete", type: ADS_TYPE.keyword, filter: "keywordIdFilter", key: "keywords" },
		negative_keyword: { path: "/sp/negativeKeywords/delete", type: ADS_TYPE.negativeKeyword, filter: "negativeKeywordIdFilter", key: "negativeKeywords" },
		campaign_negative_keyword: { path: "/sp/campaignNegativeKeywords/delete", type: ADS_TYPE.campaignNegativeKeyword, filter: "campaignNegativeKeywordIdFilter", key: "campaignNegativeKeywords" },
		product_ad: { path: "/sp/productAds/delete", type: ADS_TYPE.productAd, filter: "adIdFilter", key: "productAds" },
		target: { path: "/sp/targets/delete", type: ADS_TYPE.target, filter: "targetIdFilter", key: "targetingClauses" },
		negative_target: { path: "/sp/negativeTargets/delete", type: ADS_TYPE.negativeTarget, filter: "negativeTargetIdFilter", key: "negativeTargetingClauses" },
	};

	server.registerTool(
		"ads_archive",
		{
			description:
				"WRITE — PERMANENT. Archives (deletes) Sponsored Products items: campaign, ad_group, keyword, negative_keyword, campaign_negative_keyword, product_ad, target, negative_target. Archived items cannot be restored; their history stays in reports. Needs confirm = true AND confirm_text = 'ARCHIVE'. Removing a negative keyword is done here (entity negative_keyword).",
			inputSchema: z.object({
				entity: z.enum(["campaign", "ad_group", "keyword", "negative_keyword", "campaign_negative_keyword", "product_ad", "target", "negative_target"]),
				ids: z.array(z.string()).min(1).max(100),
				confirm: z.boolean().optional(),
				confirm_text: z.string().optional(),
			}),
		},
		async ({ entity, ids, confirm, confirm_text }: any) => {
			try {
				const m = ARCHIVE_MAP[entity];
				const plan = { archive: entity, ids, warning: "Permanent — cannot be undone." };
				if (!confirm || confirm_text !== "ARCHIVE")
					return textResult({ status: "PREVIEW — nothing archived. Call again with confirm = true and confirm_text = 'ARCHIVE'.", plan });
				const out = await adsRequest("POST", m.path, { type: m.type, body: { [m.filter]: { include: ids.map(String) } } });
				return textResult({ status: "DONE", plan, result: adsWriteResult(out, m.key) });
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_update_other_campaign",
		{
			description:
				"WRITE. Pauses or re-enables a Sponsored Brands or Sponsored Display campaign, or changes its budget (≤ ceiling). Creating SB/SD campaigns needs creatives and stays in the Ads console. Preview unless confirm = true.",
			inputSchema: z.object({
				ad_type: z.enum(["SPONSORED_BRANDS", "SPONSORED_DISPLAY"]),
				campaign_id: z.string(),
				state: z.enum(["ENABLED", "PAUSED"]).optional(),
				budget: z.number().optional(),
				confirm: z.boolean().optional(),
			}),
		},
		async ({ ad_type, campaign_id, state, budget, confirm }: any) => {
			try {
				const problems: string[] = [];
				checkBudget(budget, problems);
				if (!state && budget === undefined) problems.push("Nothing to change.");
				const plan = { ad_type, campaign_id, state, budget: budget !== undefined ? money(budget) : undefined };
				return await previewOrRun(confirm, problems, plan, async () => {
					if (ad_type === "SPONSORED_BRANDS") {
						const x: any = { campaignId: String(campaign_id) };
						if (state) x.state = state;
						if (budget !== undefined) x.budget = Number(budget);
						return adsRequest("PUT", "/sb/v4/campaigns", { type: "application/vnd.sbcampaignresource.v4+json", body: { campaigns: [x] } });
					}
					const x: any = { campaignId: Number(campaign_id) };
					if (state) x.state = state.toLowerCase();
					if (budget !== undefined) x.budget = Number(budget);
					return adsRequest("PUT", "/sd/campaigns", { body: [x] });
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	/* ================================================================
	   ADS v2 — Amazon's own recommendations, other ad types (read only),
	   budget usage and change history. DSP deliberately left out.
	   ================================================================ */

	server.registerTool(
		"ads_bid_recommendations",
		{
			description:
				"Amazon's OWN suggested bids (low / suggested / high) for exact-match keywords — first-party CPC data, which outranks Helium 10 estimates. Two modes: (1) research/launch — pass asins (the ASINs you will advertise; Amazon may refuse ASINs you don't sell) and keywords; (2) live — pass campaign_id + ad_group_id and keywords. Optional price gives the expected ACOS at 8% and 5.24% CVR for each suggested bid, and every row is checked against the bid cap.",
			inputSchema: z.object({
				keywords: z.array(z.string()).min(1).max(100),
				asins: z.array(z.string()).optional().describe("Mode 1: ASINs to advertise."),
				campaign_id: z.string().optional().describe("Mode 2 with ad_group_id."),
				ad_group_id: z.string().optional(),
				price: z.number().optional().describe("Selling price, to compute expected ACOS."),
			}),
		},
		async ({ keywords, asins, campaign_id, ad_group_id, price }: any) => {
			try {
				const { maxBid } = adsLimits();
				const kws = [...new Set(keywords.map(cleanKeyword).filter(Boolean))] as string[];
				const targetingExpressions = kws.map((k) => ({ type: "KEYWORD_EXACT_MATCH", value: k }));
				let body: any;
				if (ad_group_id && campaign_id) {
					body = { recommendationType: "BIDS_FOR_EXISTING_AD_GROUP", campaignId: String(campaign_id), adGroupId: String(ad_group_id), targetingExpressions };
				} else if (asins?.length) {
					body = { recommendationType: "BIDS_FOR_NEW_AD_GROUP", asins: asins.map((a: string) => a.trim().toUpperCase()), targetingExpressions, bidding: { strategy: "LEGACY_FOR_SALES" } };
				} else {
					return errorResult(new Error("Pass either asins, or campaign_id + ad_group_id."));
				}

				const { out, type } = await adsPostVersioned(
					"/sp/targets/bid/recommendations",
					["application/vnd.spthemebasedbidrecommendation.v4+json", "application/vnd.spthemebasedbidrecommendation.v3+json"],
					body
				);

				const themes: any[] = out.bidRecommendations || out.themes || (Array.isArray(out) ? out : []);
				const result = themes.map((th: any) => ({
					theme: th.theme,
					impact: th.impactMetrics,
					keywords: (th.bidRecommendationsForTargetingExpressions || []).map((r: any) => {
						const vals = (r.bidValues || []).map(bidOf).filter((v: any) => v != null).sort((a: number, b: number) => a - b);
						const low = vals[0] ?? null;
						const mid = vals.length ? vals[Math.floor(vals.length / 2)] : null;
						const high = vals[vals.length - 1] ?? null;
						const row: any = {
							keyword: r.targetingExpression?.value,
							match: r.targetingExpression?.type,
							low: low != null ? money(low) : null,
							suggested: mid != null ? money(mid) : null,
							high: high != null ? money(high) : null,
							vs_cap: mid == null ? null : mid <= maxBid ? "OK — under $" + money(maxBid) : "ABOVE CAP $" + money(maxBid),
						};
						if (price && mid != null) {
							row.acos_at_8pct_cvr = pct(mid / (0.08 * price));
							row.acos_at_5_24pct_cvr = pct(mid / (0.0524 * price));
						}
						return row;
					}),
				}));

				return textResult({
					source: "Amazon Ads bid recommendations (" + type.replace("application/vnd.", "") + ")",
					bid_cap: money(maxBid),
					themes: result,
					raw_if_unparsed: result.length ? undefined : out,
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_keyword_recommendations",
		{
			description:
				"Amazon's OWN keyword suggestions for one or more ASINs, ranked by Amazon, with suggested exact-match bid ranges and search-term impression rank/share where Amazon provides them. First-party alternative to Cerebro keyword lists. Amazon may only accept ASINs you sell.",
			inputSchema: z.object({
				asins: z.array(z.string()).min(1).max(50),
				max_results: z.number().optional().describe("Default 100, max 200."),
			}),
		},
		async ({ asins, max_results }: any) => {
			try {
				const { maxBid } = adsLimits();
				const max = Math.max(1, Math.min(max_results ?? 100, 200));
				const base = {
					recommendationType: "KEYWORDS_FOR_ASINS",
					asins: asins.map((a: string) => a.trim().toUpperCase()),
					maxRecommendations: max,
					sortDimension: "CLICKS",
					locale: "en_US",
				};
				let out: any, type = "";
				try {
					({ out, type } = await adsPostVersioned(
						"/sp/targets/keywords/recommendations",
						["application/vnd.spkeywordsrecommendation.v5+json", "application/vnd.spkeywordsrecommendation.v4+json"],
						{ ...base, biddingStrategy: "LEGACY_FOR_SALES", bidsEnabled: true }
					));
				} catch (e: any) {
					if (!/ 4\d\d/.test(String(e?.message || e))) throw e;
					try {
						({ out, type } = await adsPostVersioned("/sp/targets/keywords/recommendations", ["application/vnd.spkeywordsrecommendation.v3+json"], base));
					} catch (e3: any) {
						throw new Error(String(e?.message || e) + " | v3 retry: " + String(e3?.message || e3));
					}
				}

				const list: any[] = out.keywordTargetList || out.recommendations || (Array.isArray(out) ? out : []);
				const rows = list.map((k: any) => {
					const infos: any[] = k.bidInfo || [];
					const exact = infos.find((b) => String(b.matchType).toUpperCase() === "EXACT") || infos[0] || k;
					const sb = exact.suggestedBid || {};
					// v4/v5 return bids in CENTS (111 = $1.11); v3 returns dollars.
					const scale = /v[45]\+json/.test(type) ? 100 : 1;
					const rawMid = bidOf(sb.rangeMedian ?? exact.bid ?? exact.suggestedBid);
					const mid = rawMid == null ? null : rawMid / scale;
					return {
						keyword: k.keyword ?? k.keywordText,
						rank: exact.rank ?? k.rank,
						suggested_exact_bid: mid != null ? money(mid) : null,
						range: sb.rangeStart != null ? money(Number(sb.rangeStart) / scale) + "–" + money(Number(sb.rangeEnd) / scale) : undefined,
						vs_cap: mid == null ? null : mid <= maxBid ? "OK" : "ABOVE CAP",
						impression_rank: k.searchTermImpressionRank,
						impression_share: k.searchTermImpressionShare,
					};
				});
				return textResult({
					source: "Amazon Ads keyword recommendations (" + type.replace("application/vnd.", "") + ")",
					bid_cap: money(maxBid),
					count: rows.length,
					keywords: rows,
					raw_if_unparsed: rows.length ? undefined : out,
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_other_campaigns",
		{
			description:
				"READ ONLY. Sponsored Brands (headline/video) and Sponsored Display campaigns, plus portfolios. Your rules run Sponsored Products only, so these tools never create or change SB/SD campaigns. Each section reports its own error if Amazon refuses it.",
			inputSchema: z.object({
				include_archived: z.boolean().optional(),
			}),
		},
		async ({ include_archived }: any) => {
			const states = include_archived ? ["ENABLED", "PAUSED", "ARCHIVED"] : ["ENABLED", "PAUSED"];
			const section = async (fn: () => Promise<any>) => {
				try {
					return await fn();
				} catch (e: any) {
					return { error: String(e?.message || e).slice(0, 400) };
				}
			};
			const [sb, sd, portfolios] = await Promise.all([
				section(async () => {
					const items = await adsList("/sb/v4/campaigns/list", "application/vnd.sbcampaignresource.v4+json", "campaigns", {
						maxResults: 100, // SB v4 allows 1–100 per page (SP allows 1000)
						stateFilter: { include: states },
					});
					return items.map((c: any) => ({
						campaignId: c.campaignId,
						name: c.name,
						state: c.state,
						budget: c.budget,
						budgetType: c.budgetType,
						startDate: c.startDate,
						goal: c.goal,
						brandEntityId: c.brandEntityId,
					}));
				}),
				section(async () => {
					const items = await adsRequest("GET", "/sd/campaigns?stateFilter=" + states.map((s) => s.toLowerCase()).join(","));
					return (Array.isArray(items) ? items : []).map((c: any) => ({
						campaignId: c.campaignId,
						name: c.name,
						state: c.state,
						tactic: c.tactic,
						budget: c.budget,
						costType: c.costType,
						startDate: c.startDate,
					}));
				}),
				section(async () => {
					try {
						return await adsList("/portfolios/list", "application/vnd.spPortfolio.v3+json", "portfolios", {});
					} catch {
						return await adsRequest("GET", "/v2/portfolios");
					}
				}),
			]);
			return textResult({ sponsored_brands: sb, sponsored_display: sd, portfolios });
		}
	);

	server.registerTool(
		"ads_budget_usage",
		{
			description:
				"How much of today's daily budget each Sponsored Products campaign has used (percent, with Amazon's update time). Campaigns that hit 100% early in the day are running out of budget. Pass campaign_ids, or omit to check every enabled campaign.",
			inputSchema: z.object({
				campaign_ids: z.array(z.string()).optional(),
			}),
		},
		async ({ campaign_ids }: any) => {
			try {
				let ids: string[] = (campaign_ids || []).map(String);
				if (!ids.length) {
					const live = await adsList("/sp/campaigns/list", ADS_TYPE.campaign, "campaigns", { stateFilter: { include: ["ENABLED"] } });
					ids = live.map((c: any) => String(c.campaignId));
				}
				if (!ids.length) return textResult({ note: "No enabled campaigns — nothing is spending." });
				const out = await adsRequest("POST", "/sp/campaigns/budget/usage", { body: { campaignIds: ids.slice(0, 100) } });
				return textResult(out);
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"ads_change_history",
		{
			description:
				"Change history: what changed on campaigns, ad groups, keywords and product ads (budgets, bids, states), when, and the before/after values. Use it to check what was changed by hand in the Ads console. Amazon keeps a limited window (roughly 90 days).",
			inputSchema: z.object({
				days: z.number().optional().describe("How far back. Default 30, max 89."),
				max_events: z.number().optional().describe("Default 200."),
			}),
		},
		async ({ days, max_events }: any) => {
			try {
				const d = Math.max(1, Math.min(days ?? 30, 89)); // Amazon rejects exactly 90
				const out = await adsRequest("POST", "/history", {
					body: {
						fromDate: Date.now() - d * 86400000,
						toDate: Date.now(),
						eventTypes: { CAMPAIGN: {}, AD_GROUP: {}, KEYWORD: {}, AD: {} },
						count: Math.max(1, Math.min(max_events ?? 200, 200)),
						sort: { key: "DATE", direction: "DESC" },
					},
				});
				const events: any[] = out.events || [];
				return textResult({
					days: d,
					count: events.length,
					events: events.map((ev: any) => ({
						when: ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : undefined,
						entity: ev.entityType,
						id: ev.entityId,
						change: ev.changeType,
						from: ev.previousValue,
						to: ev.newValue,
						details: ev.metadata,
					})),
					nextToken: out.nextToken,
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

		// Amazon Ads sign-in lands here (registered as the LWA Allowed Return URL).
		// It only swaps Amazon's one-time code for a token; it reveals nothing else.
		if (url.pathname === ADS_CALLBACK_PATH && request.method === "GET") {
			return handleAdsCallback(url);
		}

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
