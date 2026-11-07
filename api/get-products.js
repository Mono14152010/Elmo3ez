// api/get-products.js
// Fetches products from Shopify (title, price, image, stock) AND groups them
// by their Shopify collections, so the order form can show the same
// collection sections as the store.
//
// Uses cursor-based pagination (Shopify's Link header) so stores with more
// than 250 products/collections still get everything, not just page 1.

const API_VERSION = "2025-10";

// The token is valid for ~24h, so keep it in memory between requests
// instead of asking Shopify for a new one every time.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const shop = process.env.SHOPIFY_SHOP_NAME; // e.g. "7naw6q-kd" (NO .myshopify.com)
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
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
  cachedTokenExpiry = Date.now() + Math.max(60, ttlSeconds - 300) * 1000; // 5 min safety margin
  return cachedToken;
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    if (part.includes('rel="next"')) {
      const match = part.match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Follows Shopify's Link header pagination until every page has been fetched.
// Retries automatically on 429 (rate limit).
async function shopifyGetAll(shop, accessToken, initialPath, resourceKey) {
  let url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/${initialPath}`;
  let results = [];

  while (url) {
    let res;
    let attempt = 0;

    while (true) {
      res = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
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

module.exports = async (req, res) => {
  // Shared cache for 30s (stale copy allowed for another 60s while it refreshes):
  // keeps the form near-real-time but stops every visitor from hitting Shopify's
  // 2-requests/second limit.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");

  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

    // 1) ALL active products with the fields we need (paginated). status=active
    // excludes drafts and archived items so they never show in the form.
    const rawProducts = await shopifyGetAll(
      shop,
      accessToken,
      "products.json?limit=250&status=active&fields=id,title,image,images,variants",
      "products"
    );

    const products = rawProducts
      .map((p) => {
        const image = p.image ? p.image.src : (p.images && p.images[0] ? p.images[0].src : null);

        const variants = (p.variants || [])
          .map((v) => {
            const qty = v.inventory_quantity;
            const inStock = qty === null || qty === undefined ? true : qty > 0;
            return {
              variant_id: v.id,
              title: v.title === "Default Title" ? null : v.title,
              price: v.price,
              in_stock: inStock,
            };
          })
          // Only keep variants that are actually available — out-of-stock
          // options shouldn't be orderable at all.
          .filter((v) => v.in_stock)
          // Customers only need to know "available": don't send stock numbers.
          .map(({ variant_id, title, price }) => ({ variant_id, title, price }));

        return { product_id: p.id, title: p.title, image, variants, collection_titles: [] };
      })
      // Drop products left with zero available variants entirely.
      .filter((p) => p.variants.length > 0);

    const productsById = new Map(products.map((p) => [p.product_id, p]));

    // 2) ALL collections (both manually curated "custom" and rule-based "smart"), paginated.
    // Sequential (not parallel) to respect Shopify's rate limit.
    const customCollections = await shopifyGetAll(
      shop, accessToken, "custom_collections.json?limit=250&fields=id,title,image", "custom_collections"
    );
    const smartCollections = await shopifyGetAll(
      shop, accessToken, "smart_collections.json?limit=250&fields=id,title,image", "smart_collections"
    );

    const allCollections = [...customCollections, ...smartCollections];
    const customCollectionIds = new Set(customCollections.map((c) => c.id));
    const memberCounts = new Map(); // collection id -> how many products Shopify says it has

    // 3) Membership:
    //    - For custom (manually curated) collections, "collects.json" gives us
    //      every collection_id/product_id pair in just a few paginated calls.
    //    - Smart (rule-based) collections aren't listed there, so those still
    //      need one products.json?collection_id=X call each.
    if (customCollectionIds.size > 0) {
      const collects = await shopifyGetAll(
        shop, accessToken, "collects.json?limit=250&fields=collection_id,product_id", "collects"
      );
      const collectionById = new Map(allCollections.map((c) => [c.id, c]));
      collects.forEach((c) => {
        memberCounts.set(c.collection_id, (memberCounts.get(c.collection_id) || 0) + 1);
        const product = productsById.get(c.product_id);
        const collection = collectionById.get(c.collection_id);
        if (product && collection) product.collection_titles.push(collection.title);
      });
    }

    for (const col of smartCollections) {
      const members = await shopifyGetAll(
        shop,
        accessToken,
        `products.json?collection_id=${col.id}&limit=250&fields=id`,
        "products"
      );
      memberCounts.set(col.id, members.length);
      members.forEach((mp) => {
        const product = productsById.get(mp.id);
        if (product) product.collection_titles.push(col.title);
      });
    }

    // Small picture for each collection (shown on the category buttons).
    const thumb = (src) => {
      try {
        const u = new URL(src);
        u.searchParams.set("width", "240");
        return u.toString();
      } catch (e) {
        return null;
      }
    };
    const collections = allCollections.map((c) => ({
      id: c.id,
      title: c.title,
      image: c.image && c.image.src ? thumb(c.image.src) : null,
    }));

    const result = { products, collections };

    // Troubleshooting helper: open /api/get-products?debug=1 to see every collection
    // Shopify returned, its type, and how many products it contains (names + counts only).
    if (req.query && req.query.debug === "1") {
      result.debug = allCollections.map((c) => ({
        id: c.id,
        title: c.title,
        type: customCollectionIds.has(c.id) ? "custom" : "smart",
        products_in_shopify: memberCounts.get(c.id) || 0,
        shown_in_form: products.filter((p) => p.collection_titles.includes(c.title)).length,
      }));
    }

    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "تعذر تحميل المنتجات حاليًا" });
  }
};
