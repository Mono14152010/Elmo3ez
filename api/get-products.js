async function getAccessToken(shop, clientId, clientSecret) {
  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Token exchange failed: ' + text);
  }
  const data = await res.json();
  return data.access_token;
}

module.exports = async (req, res) => {
  const shop = process.env.SHOPIFY_SHOP_NAME;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    res.status(500).json({ message: 'Missing Shopify credentials in environment variables' });
    return;
  }

  try {
    const token = await getAccessToken(shop, clientId, clientSecret);

    const response = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-01/products.json?limit=100&status=active`,
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
