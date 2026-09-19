// api/create-draft-order.js
// Creates a Shopify Draft Order from the submitted form data, including a
// shipping_line whose price is looked up server-side from the SAME static
// list as api/get-shipping.js (so a customer can't tamper with the delivery
// price in the browser).
//
// ⚠️ This list must match api/get-shipping.js exactly. If you change a
// price in one file, change it in the other too.

const API_VERSION = "2025-10";

const SHIPPING_ZONES = [
  { zone_id: "cairo", zone_name: "القاهرة", rates: [
      { rate_name: "اكسبريس", price: 200 },
      { rate_name: "ستاندرد", price: 80 },
  ]},
  { zone_id: "giza", zone_name: "الجيزة", rates: [
      { rate_name: "اكسبريس", price: 230 },
      { rate_name: "ستاندرد", price: 90 },
  ]},
  { zone_id: "6th_october", zone_name: "6 أكتوبر", rates: [
      { rate_name: "اكسبريس", price: 230 },
      { rate_name: "ستاندرد", price: 80 },
  ]},
  { zone_id: "helwan", zone_name: "حلوان", rates: [
      { rate_name: "ستاندرد", price: 150 },
  ]},
  { zone_id: "governments", zone_name: "الشرقية، البحيرة، الدقهلية، دمياط، الغربية، كفر الشيخ، المنوفية، القليوبية", rates: [
      { rate_name: "ستاندرد", price: 175 },
  ]},
  { zone_id: "middle_egypt", zone_name: "الإسكندرية، بني سويف، الفيوم", rates: [
      { rate_name: "ستاندرد", price: 175 },
  ]},
  { zone_id: "north_upper_egypt", zone_name: "أسيوط، الإسماعيلية، بورسعيد، السويس", rates: [
      { rate_name: "ستاندرد", price: 185 },
  ]},
  { zone_id: "minya", zone_name: "المنيا", rates: [
      { rate_name: "ستاندرد", price: 230 },
  ]},
  { zone_id: "north_egypt", zone_name: "مطروح، شمال سيناء، جنوب سيناء", rates: [
      { rate_name: "ستاندرد", price: 230 },
  ]},
  { zone_id: "deep_upper_egypt", zone_name: "أسوان، الأقصر، الوادي الجديد، قنا، البحر الأحمر، سوهاج", rates: [
      { rate_name: "ستاندرد", price: 200 },
  ]},
  { zone_id: "asia", zone_name: "دول الخليج (الإمارات، البحرين، الكويت، عُمان، قطر، السعودية)", rates: [
      { rate_name: "اكسبريس", price: 6000 },
  ]},
];

function findAuthoritativeRate(zoneId, rateName) {
  const zone = SHIPPING_ZONES.find((z) => z.zone_id === zoneId);
  if (!zone) return null;
  const rate = zone.rates.find((r) => r.rate_name === rateName);
  if (!rate) return null;
  return { zone_name: zone.zone_name, rate_name: rate.rate_name, price: rate.price };
}

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
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { customer, items, shipping } = req.body;

    if (!customer || !customer.name || !customer.phone || !customer.address) {
      res.status(400).json({ error: "Missing customer info" });
      return;
    }
    if (!items || !items.length) {
      res.status(400).json({ error: "No items in order" });
      return;
    }

    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

    const draftOrder = {
      line_items: items.map((i) => ({
        variant_id: i.variant_id,
        quantity: i.quantity,
      })),
      shipping_address: {
        first_name: customer.name,
        address1: customer.address,
        phone: customer.phone,
        country: "Egypt",
      },
      note: `الاسم: ${customer.name}\nالتليفون: ${customer.phone}\nالعنوان: ${customer.address}`,
      tags: "order-form",
    };

    if (shipping && shipping.zone_id && shipping.rate_name) {
      const authoritative = findAuthoritativeRate(shipping.zone_id, shipping.rate_name);
      if (authoritative) {
        draftOrder.shipping_line = {
          title: `${authoritative.zone_name} - ${authoritative.rate_name}`,
          price: authoritative.price,
        };
      }
    }

    const orderRes = await fetch(
      `https://${shop}.myshopify.com/admin/api/${API_VERSION}/draft_orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ draft_order: draftOrder }),
      }
    );

    if (!orderRes.ok) {
      const text = await orderRes.text();
      throw new Error(`Shopify draft order creation failed: ${orderRes.status} ${text}`);
    }

    const orderData = await orderRes.json();
    res.status(200).json({ success: true, draft_order: orderData.draft_order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
