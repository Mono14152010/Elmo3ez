// api/get-products.js
// Fetches products from Shopify (title, price, image, stock) AND groups them
// by their Shopify collections, so the order form can show the same
// collection sections as the store.

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

async function shopifyGet(shop, accessToken, path) {
  const res = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/${path}`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify request failed (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

    // 1) All products with the fields we need.
    const productsData = await shopifyGet(
      shop,
      accessToken,
      "products.json?limit=250&fields=id,title,image,images,variants"
    );

    const products = (productsData.products || []).map((p) => {
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

    // 2) All collections (both manually curated "custom" and rule-based "smart").
    const [customCollectionsData, smartCollectionsData] = await Promise.all([
      shopifyGet(shop, accessToken, "custom_collections.json?limit=250&fields=id,title"),
      shopifyGet(shop, accessToken, "smart_collections.json?limit=250&fields=id,title"),
    ]);

    const allCollections = [
      ...(customCollectionsData.custom_collections || []),
      ...(smartCollectionsData.smart_collections || []),
    ];

    // 3) For each collection, find which products belong to it.
    await Promise.all(
      allCollections.map(async (col) => {
        const memberData = await shopifyGet(
          shop,
          accessToken,
          `products.json?collection_id=${col.id}&limit=250&fields=id`
        );
        (memberData.products || []).forEach((mp) => {
          const product = productsById.get(mp.id);
          if (product) product.collection_titles.push(col.title);
        });
      })
    );

    const collections = allCollections.map((c) => ({ id: c.id, title: c.title }));

    res.status(200).json({ products, collections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
