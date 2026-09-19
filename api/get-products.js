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

// Follows Shopify's Link header pagination until every page has been fetched.
async function shopifyGetAll(shop, accessToken, initialPath, resourceKey) {
  let url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/${initialPath}`;
  let results = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

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
  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

    // 1) ALL products with the fields we need (paginated).
    const rawProducts = await shopifyGetAll(
      shop,
      accessToken,
      "products.json?limit=250&fields=id,title,image,images,variants",
      "products"
    );

    const products = rawProducts.map((p) => {
      const image = p.image ? p.image.src : (p.images && p.images[0] ? p.images[0].src : null);

      const variants = (p.variants || []).map((v) => {
        const qty = v.inventory_quantity;
        const inStock = qty === null || qty === undefined ? true : qty > 0;
        return {
          variant_id: v.id,
          title: v.title === "Default Title" ? null : v.title,
          price: v.price,
          in_stock: inStock,
          inventory_quantity: qty === null || qty === undefined ? null : qty,
        };
      });

      return { product_id: p.id, title: p.title, image, variants, collection_titles: [] };
    });

    const productsById = new Map(products.map((p) => [p.product_id, p]));

    // 2) ALL collections (both manually curated "custom" and rule-based "smart"), paginated.
    const [customCollections, smartCollections] = await Promise.all([
      shopifyGetAll(shop, accessToken, "custom_collections.json?limit=250&fields=id,title", "custom_collections"),
      shopifyGetAll(shop, accessToken, "smart_collections.json?limit=250&fields=id,title", "smart_collections"),
    ]);

    const allCollections = [...customCollections, ...smartCollections];

    // 3) For each collection, find which products belong to it (paginated per collection).
    for (const col of allCollections) {
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
