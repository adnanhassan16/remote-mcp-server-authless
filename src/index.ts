import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const SP_HOST = "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SELLER_ID = "A2ZPQEA709W727";

let currentEnv: any = null;
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

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
	const res = await fetch(SP_HOST + path, {
		headers: {
			"x-amz-access-token": token,
			"Content-Type": "application/json",
		},
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error("SP-API " + res.status + ": " + text.slice(0, 400));
	}
	return JSON.parse(text);
}

function daysAgoISO(days: number): string {
	return new Date(Date.now() - days * 86400000).toISOString();
}

function textResult(obj: any) {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(e: any) {
	return { content: [{ type: "text" as const, text: "Error: " + (e?.message || String(e)) }] };
}

function createServer() {
	const server = new McpServer({
		name: "AH Inside Seller Central",
		version: "1.0.0",
	});

	server.registerTool(
		"get_inventory",
		{
			description: "Current FBA inventory levels for every SKU in the US marketplace.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const data = await spGet(
					"/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=" +
						MARKETPLACE_ID +
						"&marketplaceIds=" +
						MARKETPLACE_ID +
						"&details=true"
				);
				const rows = (data?.payload?.inventorySummaries || []).map((s: any) => ({
					sku: s.sellerSku,
					asin: s.asin,
					name: s.productName,
					fulfillable: s.inventoryDetails?.fulfillableQuantity ?? 0,
					inbound_working: s.inventoryDetails?.inboundWorkingQuantity ?? 0,
					inbound_shipped: s.inventoryDetails?.inboundShippedQuantity ?? 0,
					inbound_receiving: s.inventoryDetails?.inboundReceivingQuantity ?? 0,
					unfulfillable:
						s.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
					reserved: s.inventoryDetails?.reservedQuantity?.totalReservedQuantity ?? 0,
				}));
				return textResult({ count: rows.length, inventory: rows });
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"get_financials",
		{
			description:
				"Financial events for a recent period: product charges, fees, refunds. Defaults to the last 30 days.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30, maximum 180."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.min(days ?? 30, 180);
				const data = await spGet(
					"/finances/v0/financialEvents?PostedAfter=" +
						encodeURIComponent(daysAgoISO(window)) +
						"&MaxResultsPerPage=100"
				);
				const ev = data?.payload?.FinancialEvents || {};
				const shipments = ev.ShipmentEventList || [];

				let productCharges = 0;
				let fees = 0;
				for (const s of shipments) {
					for (const item of s.ShipmentItemList || []) {
						for (const c of item.ItemChargeList || []) {
							productCharges += Number(c.ChargeAmount?.CurrencyAmount || 0);
						}
						for (const f of item.ItemFeeList || []) {
							fees += Number(f.FeeAmount?.CurrencyAmount || 0);
						}
					}
				}

				return textResult({
					period_days: window,
					shipment_events: shipments.length,
					refund_events: (ev.RefundEventList || []).length,
					service_fee_events: (ev.ServiceFeeEventList || []).length,
					product_charges_usd: productCharges.toFixed(2),
					fees_usd: fees.toFixed(2),
					net_usd: (productCharges + fees).toFixed(2),
				});
			} catch (e) {
				return errorResult(e);
			}
		}
	);

	server.registerTool(
		"get_order_summary",
		{
			description:
				"Order counts, units and gross revenue for a recent period. Returns no buyer names or addresses. Defaults to the last 30 days.",
			inputSchema: z.object({
				days: z.number().optional().describe("Days to look back. Default 30, maximum 180."),
			}),
		},
		async ({ days }: any) => {
			try {
				const window = Math.min(days ?? 30, 180);
				const data = await spGet(
					"/orders/v0/orders?MarketplaceIds=" +
						MARKETPLACE_ID +
						"&CreatedAfter=" +
						encodeURIComponent(daysAgoISO(window)) +
						"&MaxResultsPerPage=100"
				);
				const orders = data?.payload?.Orders || [];

				const byStatus: Record<string, number> = {};
				let total = 0;
				let units = 0;
				for (const o of orders) {
					byStatus[o.OrderStatus] = (byStatus[o.OrderStatus] || 0) + 1;
					total += Number(o.OrderTotal?.Amount || 0);
					units +=
						Number(o.NumberOfItemsShipped || 0) + Number(o.NumberOfItemsUnshipped || 0);
				}

				return textResult({
					period_days: window,
					order_count: orders.length,
					units: units,
					gross_usd: total.toFixed(2),
					by_status: byStatus,
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
				"Full listing detail for one SKU: attributes, status, fulfilment availability and any listing issues.",
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
						"&includedData=summaries,attributes,issues,offers,fulfillmentAvailability"
				);
				return textResult(data);
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
