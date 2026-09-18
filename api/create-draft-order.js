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
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const shop = process.env.SHOPIFY_SHOP_NAME;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    res.status(500).json({ message: 'Missing Shopify credentials in environment variables' });
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
    const token = await getAccessToken(shop, clientId, clientSecret);

    const shopifyRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-01/draft_orders.json`,
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
              first_name: firstName,
              last_name: lastName,
              address1: address,
              phone: phone,
              country: 'Egypt'
            },
            note: `طلب من فورم الموقع — التليفون: ${phone}`,
            tags: 'website-order-form'
          }
        })
      }
    );

    const data = await shopifyRes.json();

    if (!shopifyRes.ok) {
      res.status(400).json({ message: 'Shopify رفض الطلب', details: data });
      return;
    }

    res.status(201).json({
      success: true,
      draft_order_id: data.draft_order.id,
      message: 'تم إنشاء الطلب بنجاح'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
