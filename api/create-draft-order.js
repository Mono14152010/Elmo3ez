import { getShopifyAccessToken } from '@/lib/shopify-auth';

export default async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const shop = process.env.SHOPIFY_SHOP_NAME;

  if (!shop) {
    res.status(500).json({ message: 'Missing Shopify shop name in environment variables' });
    return;
  }

  const { name, phone, address, items } = req.body || {};

  if (!name || !phone || !address || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: 'بيانات ناقصة — الاسم والتليفون والعنوان وصنف واحد على الأقل مطلوبين' });
    return;
  }

  const nameParts = String(name).trim().split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || firstName;

  try {
    // احصل على التوكن الديناميكي
    const token = await getShopifyAccessToken();

    const shopifyRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-07/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          draft_order: {
            line_items: items.map(it => ({
              variant_id: it.variant_id,
              quantity: it.quantity
            })),
            customer: {
              first_name: firstName,
              last_name: lastName,
              phone: phone
            },
            shipping_address: {
              address1: address,
              country: 'EG'
            }
          }
        })
      }
    );

    if (!shopifyRes.ok) {
      const errorData = await shopifyRes.json();
      res.status(shopifyRes.status).json({ message: 'فشل إنشاء الطلب', error: errorData });
      return;
    }

    const data = await shopifyRes.json();
    res.status(201).json(data);
  } catch (error) {
    console.error('Error creating draft order:', error);
    res.status(500).json({ message: 'خطأ في الخادم', error: error.message });
  }
};
