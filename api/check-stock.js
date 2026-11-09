// api/check-stock.js
// Live stock check used by the order form every time a customer raises a quantity.
// It asks Shopify right now and answers only yes/no — the real stock number is
// never sent to the browser.

const API_VERSION = "2025-10";
const MAX_QTY = 50;
const RATE_LIMIT_MAX = 300; // checks allowed per IP...
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes (per server instance)
const MICRO_CACHE_MS = 2000; // answers for the same product are reused for 2 seconds

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Shopify access ----------

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

// Returns { active, variants: Map(variant_id -> quantity or null) } or null if the product doesn't exist.
const productCache = new Map(); // product_id -> { at, value }

async function getProductStock(productId) {
  const hit = productCache.get(productId);
  if (hit && Date.now() - hit.at < MICRO_CACHE_MS) return hit.value;

  const shop = process.env.SHOPIFY_SHOP_NAME;
  const accessToken = await getAccessToken();
  const url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/products/${productId}.json?fields=id,status,variants`;

  let res;
  let attempt = 0;
  while (true) {
    res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    });
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000 + 100);
      attempt++;
      continue;
    }
    break;
  }

  let value = null;
  if (res.status === 404) {
    value = null;
  } else if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify product request failed: ${res.status} ${text}`);
  } else {
    const product = (await res.json()).product || {};
    const variants = new Map();
    for (const v of product.variants || []) {
      const qty = v.inventory_quantity;
      variants.set(Number(v.id), qty === null || qty === undefined ? null : Number(qty));
    }
    value = { active: product.status === "active", variants };
  }

  productCache.set(productId, { at: Date.now(), value });
  if (productCache.size > 500) productCache.clear();
  return value;
}

// ---------- tiny per-IP limiter (slows spammers; not a perfect wall) ----------

const hits = new Map();
function tooManyRequests(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT_MAX;
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
    const productId = Number(body.product_id);
    const variantId = Number(body.variant_id);
    const quantity = Number(body.quantity);

    if (!Number.isInteger(productId) || productId <= 0 ||
        !Number.isInteger(variantId) || variantId <= 0 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    if (tooManyRequests(ip)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const stock = await getProductStock(productId);
    if (!stock || !stock.active || !stock.variants.has(variantId)) {
      res.status(200).json({ available: false, soldOut: true });
      return;
    }

    const qty = stock.variants.get(variantId); // null = not tracked = always available
    const soldOut = qty !== null && qty <= 0;
    const available = qty === null || qty >= quantity;
    res.status(200).json({ available, soldOut });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not check stock" });
  }
};
