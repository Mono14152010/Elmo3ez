module.exports = async (req, res) => {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const shop = process.env.SHOPIFY_SHOP_NAME;

  if (!token || !shop) {
    res.status(500).json({ message: 'Missing Shopify credentials in environment variables' });
    return;
  }

  try {
    const response = await fetch(
      `https://${shop}.myshopify.com/admin/api/2024-01/products.json?limit=100&status=active`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ message: 'Shopify error', details: errText });
      return;
    }

    const data = await response.json();
    const products = [];
    (data.products || []).forEach(product => {
      (product.variants || []).forEach(variant => {
        products.push({
          variant_id: variant.id,
          title: product.variants.length > 1
            ? `${product.title} — ${variant.title}`
            : product.title,
          price: variant.price
        });
      });
    });

    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
