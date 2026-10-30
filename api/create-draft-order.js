// api/create-draft-order.js
// Creates a Shopify Draft Order from the order form, then sends a WhatsApp
// notification to the store owner via CallMeBot.
//
// Everything that matters is decided HERE on the server, never trusted from
// the browser: prices (Shopify computes them), shipping price (list below),
// stock, quantities, and what appears in the WhatsApp message.
//
// ⚠️ The SHIPPING_ZONES list below must match api/get-shipping.js exactly.
// If you change a price in one file, change it in the other too.

const API_VERSION = "2025-10";

const MAX_QTY_PER_ITEM = 50;
const MAX_DISTINCT_ITEMS = 30;
const RATE_LIMIT_MAX = 10; // orders allowed per IP...
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes (per server instance)

const SHIPPING_ZONES = [
  { zone_id: "cairo", zone_name: "القاهرة", rates: [
      { rate_name: "اكسبريس", price: 200 },
      { rate_name: "ستاندرد", price: 80 },
  ]},
  { zone_id: "giza", zone_name: "الجيزة", rates: [
      { rate_name: "اكسبريس", price: 230 },
      { rate_name: "ستاندرد", price: 90 },
  ]},
  { zone_id: "6th_october", zone_name: "6 أكتوبر", rates: [
      { rate_name: "اكسبريس", price: 230 },
      { rate_name: "ستاندرد", price: 80 },
  ]},
  { zone_id: "helwan", zone_name: "حلوان", rates: [
      { rate_name: "ستاندرد", price: 150 },
  ]},
  { zone_id: "governments", zone_name: "الشرقية، البحيرة، الدقهلية، دمياط، الغربية، كفر الشيخ، المنوفية، القليوبية", rates: [
      { rate_name: "ستاندرد", price: 175 },
  ]},
  { zone_id: "middle_egypt", zone_name: "الإسكندرية، بني سويف، الفيوم", rates: [
      { rate_name: "ستاندرد", price: 175 },
  ]},
  { zone_id: "north_upper_egypt", zone_name: "أسيوط، الإسماعيلية، بورسعيد، السويس", rates: [
      { rate_name: "ستاندرد", price: 185 },
  ]},
  { zone_id: "minya", zone_name: "المنيا", rates: [
      { rate_name: "ستاندرد", price: 230 },
  ]},
  { zone_id: "north_egypt", zone_name: "مطروح، شمال سيناء، جنوب سيناء", rates: [
      { rate_name: "ستاندرد", price: 230 },
  ]},
  { zone_id: "deep_upper_egypt", zone_name: "أسوان، الأقصر، الوادي الجديد، قنا، البحر الأحمر، سوهاج", rates: [
      { rate_name: "ستاندرد", price: 200 },
  ]},
  { zone_id: "asia", zone_name: "دول الخليج (الإمارات، البحرين، الكويت، عُمان، قطر، السعودية)", rates: [
      { rate_name: "اكسبريس", price: 6000 },
  ]},
];

function findAuthoritativeRate(zoneId, rateName) {
  const zone = SHIPPING_ZONES.find((z) => z.zone_id === zoneId);
  if (!zone) return null;
  const rate = zone.rates.find((r) => r.rate_name === rateName);
  if (!rate) return null;
  return { zone_name: zone.zone_name, rate_name: rate.rate_name, price: rate.price };
}

// ---------- small helpers ----------

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}

// One line, no control characters, limited length.
function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function money(n) {
  return `${Number(n).toLocaleString("ar-EG")} جنيه`;
}

// Very simple in-memory limiter. Serverless instances don't share memory, so this
// only slows down a spammer; it is not a perfect wall.
const hits = new Map();
function tooManyRequests(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT_MAX;
}

// ---------- Shopify ----------

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const shop = process.env.SHOPIFY_SHOP_NAME; // e.g. "7naw6q-kd" (NO .myshopify.com)
  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  const ttlSeconds = Number(data.expires_in) || 3600;
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
  return cachedToken;
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (part.includes('rel="next"')) {
      const match = part.match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
}

async function shopifyGetAll(shop, accessToken, initialPath, resourceKey) {
  let url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/${initialPath}`;
  let results = [];

  while (url) {
    let res;
    let attempt = 0;
    while (true) {
      res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      });
      if (res.status === 429 && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep(retryAfter * 1000 + 200);
        attempt++;
        continue;
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify request failed (${url}): ${res.status} ${text}`);
    }
    const data = await res.json();
    results = results.concat(data[resourceKey] || []);
    url = getNextPageUrl(res.headers.get("link") || res.headers.get("Link"));
  }
  return results;
}

// Map of variant_id -> available quantity (null = not tracked), active products only.
async function getVariantStock(shop, accessToken) {
  const products = await shopifyGetAll(
    shop,
    accessToken,
    "products.json?limit=250&status=active&fields=id,variants",
    "products"
  );
  const stock = new Map();
  for (const p of products) {
    for (const v of p.variants || []) {
      const qty = v.inventory_quantity;
      stock.set(Number(v.id), qty === null || qty === undefined ? null : Number(qty));
    }
  }
  return stock;
}

// ---------- WhatsApp ----------

async function sendWhatsAppNotification({ customer, lines, shippingLine, total, invoiceUrl }) {
  const phone = process.env.WHATSAPP_PHONE; // e.g. "+201028199093"
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) return; // not configured — skip silently

  const itemLines = lines.map((l) => `- ${l.title} × ${l.quantity}`).join("\n");

  const message =
    `🛍️ *طلب جديد من الفورم!*\n\n` +
    `👤 الاسم: ${customer.name}\n` +
    `📞 التليفون: ${customer.phone}\n` +
    `📍 العنوان: ${customer.address}\n\n` +
    `🧾 المنتجات:\n${itemLines}\n\n` +
    `🚚 التوصيل: ${shippingLine.title} (${money(shippingLine.price)})\n` +
    `💰 الإجمالي: ${money(total)}` +
    (invoiceUrl ? `\n\n💳 رابط الدفع: ${invoiceUrl}` : "");

  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;

  try {
    // Don't make the customer wait long if CallMeBot is slow.
    await fetch(url, { signal: AbortSignal.timeout(4000) });
  } catch (err) {
    // Never let a WhatsApp failure break order creation.
    console.error("WhatsApp notification failed:", err.message);
  }
}

// ---------- handler ----------

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    // Honeypot: real people never see/fill this field. Pretend success to bots.
    if (body.hp_x7q) {
      console.warn("Honeypot field was filled - order ignored as bot traffic");
      res.status(200).json({ success: true });
      return;
    }

    const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    if (tooManyRequests(ip)) {
      throw new UserError("طلبات كتير في وقت قصير، حاول تاني بعد شوية", 429);
    }

    // ----- customer -----
    const customer = {
      name: clean(body.customer && body.customer.name, 80),
      phone: clean(normalizeDigits((body.customer && body.customer.phone) || ""), 20),
      address: clean(body.customer && body.customer.address, 300),
    };
    if (!customer.name || !customer.phone || !customer.address) {
      throw new UserError("من فضلك املأ كل البيانات");
    }
    if (!/^[+0-9\s-]{8,20}$/.test(customer.phone)) {
      throw new UserError("رقم التليفون مش صحيح");
    }

    // ----- items (merge duplicates, validate) -----
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const wanted = new Map(); // variant_id -> quantity
    for (const i of rawItems) {
      const variantId = Number(i && i.variant_id);
      const quantity = Number(i && i.quantity);
      if (!Number.isInteger(variantId) || variantId <= 0) throw new UserError("بيانات المنتجات غير صحيحة");
      if (!Number.isInteger(quantity) || quantity < 1) throw new UserError("الكمية غير صحيحة");
      wanted.set(variantId, (wanted.get(variantId) || 0) + quantity);
    }
    if (wanted.size === 0) throw new UserError("اختار منتج واحد على الأقل");
    if (wanted.size > MAX_DISTINCT_ITEMS) throw new UserError("عدد الأصناف كبير جدًا في طلب واحد");
    for (const q of wanted.values()) {
      if (q > MAX_QTY_PER_ITEM) throw new UserError(`أقصى كمية للصنف الواحد ${MAX_QTY_PER_ITEM}`);
    }

    // ----- shipping (required) -----
    const shipping = body.shipping || {};
    const authoritative = findAuthoritativeRate(String(shipping.zone_id || ""), String(shipping.rate_name || ""));
    if (!authoritative) throw new UserError("اختار المحافظة ونوع التوصيل");
    const shippingLine = {
      title: `${authoritative.zone_name} - ${authoritative.rate_name}`,
      price: authoritative.price,
    };

    // ----- stock check against Shopify right now -----
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();
    const stock = await getVariantStock(shop, accessToken);
    for (const [variantId, quantity] of wanted) {
      if (!stock.has(variantId)) {
        throw new UserError("أحد المنتجات لم يعد متاحًا، حدّث الصفحة وجرب تاني", 409);
      }
      const available = stock.get(variantId);
      if (available !== null && available < quantity) {
        throw new UserError("الكمية المطلوبة من أحد المنتجات غير متاحة، حدّث الصفحة وجرب تاني", 409);
      }
    }

    // ----- create the draft order -----
    const draftOrder = {
      line_items: Array.from(wanted, ([variant_id, quantity]) => ({ variant_id, quantity })),
      shipping_address: {
        first_name: customer.name,
        address1: customer.address,
        phone: customer.phone,
        country: "Egypt",
      },
      shipping_line: shippingLine,
      note:
        `الاسم: ${customer.name}\nالتليفون: ${customer.phone}\nالعنوان: ${customer.address}\n` +
        `منطقة الشحن: ${authoritative.zone_name}`,
      tags: "order-form",
    };

    const orderRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/${API_VERSION}/draft_orders.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ draft_order: draftOrder }),
      }
    );
    if (!orderRes.ok) {
      const text = await orderRes.text();
      throw new Error(`Shopify draft order creation failed: ${orderRes.status} ${text}`);
    }

    const created = (await orderRes.json()).draft_order || {};
    const invoiceUrl = created.invoice_url || null;

    // Names and total come from Shopify's own answer, not from the browser.
    const lines = (created.line_items || []).map((l) => ({
      title: l.variant_title ? `${l.title} (${l.variant_title})` : l.title,
      quantity: l.quantity,
    }));
    const total = Number(created.total_price) || Number(shippingLine.price);

    await sendWhatsAppNotification({ customer, lines, shippingLine, total, invoiceUrl });

    res.status(200).json({ success: true, invoice_url: invoiceUrl });
  } catch (err) {
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err); // full details only in Vercel logs
    res.status(500).json({ error: "حصل خطأ أثناء إرسال الطلب، حاول تاني بعد شوية" });
  }
};
