module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const shop = process.env.SHOPIFY_SHOP_NAME;

  if (!token || !shop) {
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
    const shopifyRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/2024-01/draft_orders.json`,
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
