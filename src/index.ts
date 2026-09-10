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
       a SEPARATE application.
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

/* ------------------------------------------------------------------ */
/*  SERVER                                                             */
/* ------------------------------------------------------------------ */

function createServer() {
	const server = new McpServer({
		name: "AH Inside Seller Central",
		version: "5.0.0",
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
