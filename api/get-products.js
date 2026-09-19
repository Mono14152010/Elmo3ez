// api/get-products.js
// Fetches products from Shopify (title, price, image, stock) for the order form.

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

module.exports = async (req, res) => {
  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

    const productsRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/${API_VERSION}/products.json?limit=250&fields=id,title,image,images,variants`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!productsRes.ok) {
      const text = await productsRes.text();
      throw new Error(`Shopify products fetch failed: ${productsRes.status} ${text}`);
    }

    const data = await productsRes.json();

    const products = (data.products || []).map((p) => {
      const image = p.image ? p.image.src : (p.images && p.images[0] ? p.images[0].src : null);

      const variants = (p.variants || []).map((v) => {
        // inventory_quantity is read-only but still returned on GET.
        // Treat null/undefined (not tracked) as available; 0 or less as out of stock.
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

      return {
        product_id: p.id,
        title: p.title,
        image,
        variants,
      };
    });

    res.status(200).json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
