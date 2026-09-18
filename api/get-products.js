import { getShopifyAccessToken } from '@/lib/shopify-auth';

export default async (req, res) => {
  const shop = process.env.SHOPIFY_SHOP_NAME;

  if (!shop) {
    res.status(500).json({ message: 'Missing Shopify shop name in environment variables' });
    return;
  }

  try {
    // احصل على التوكن الديناميكي
    const token = await getShopifyAccessToken();

    const response = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-07/products.json?limit=100&status=active`,
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
