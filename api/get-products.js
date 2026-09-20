// api/get-products.js
// Fetches products from Shopify (title, price, image, stock) AND groups them
// by their Shopify collections, so the order form can show the same
// collection sections as the store.
//
// Uses cursor-based pagination (Shopify's Link header) so stores with more
// than 250 products/collections still get everything, not just page 1.

const API_VERSION = "2025-10";

async function getAccessToken() {
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
  return data.access_token;
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
// Retries automatically on 429 (rate limit) and paces requests so we stay
// under Shopify's ~2 requests/second limit for this app.
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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

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
              inventory_quantity: qty === null || qty === undefined ? null : qty,
            };
          })
          // Only keep variants that are actually available — out-of-stock
          // options shouldn't be orderable at all.
          .filter((v) => v.in_stock);

        return { product_id: p.id, title: p.title, image, variants, collection_titles: [] };
      })
      // Drop products left with zero available variants entirely.
      .filter((p) => p.variants.length > 0);

    const productsById = new Map(products.map((p) => [p.product_id, p]));

    // 2) ALL collections (both manually curated "custom" and rule-based "smart"), paginated.
    // Sequential (not parallel) to respect Shopify's rate limit.
    const customCollections = await shopifyGetAll(
      shop, accessToken, "custom_collections.json?limit=250&fields=id,title", "custom_collections"
    );
    const smartCollections = await shopifyGetAll(
      shop, accessToken, "smart_collections.json?limit=250&fields=id,title", "smart_collections"
    );

    const allCollections = [...customCollections, ...smartCollections];
    const customCollectionIds = new Set(customCollections.map((c) => c.id));

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
      members.forEach((mp) => {
        const product = productsById.get(mp.id);
        if (product) product.collection_titles.push(col.title);
      });
    }

    const collections = allCollections.map((c) => ({ id: c.id, title: c.title }));

    res.status(200).json({ products, collections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
