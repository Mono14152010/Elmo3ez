// api/create-draft-order.js
// Creates a Shopify Draft Order from the submitted form data (with a
// server-validated shipping_line), then sends a WhatsApp notification
// to the store owner via the free CallMeBot API.
//
// ⚠️ The SHIPPING_ZONES list below must match api/get-shipping.js exactly.
// If you change a price in one file, change it in the other too.

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

function money(n) {
  return `${Number(n).toLocaleString("ar-EG")} جنيه`;
}

async function sendWhatsAppNotification({ customer, items, shippingLine, total }) {
  const phone = process.env.WHATSAPP_PHONE; // e.g. "+201028199093"
  const apikey = process.env.CALLMEBOT_APIKEY; // e.g. "1873807"
  if (!phone || !apikey) return; // not configured — skip silently

  const itemLines = items
    .map((i) => `- ${i.title || "منتج"} × ${i.quantity}`)
    .join("\n");

  const shippingLineText = shippingLine
    ? `${shippingLine.title} (${money(shippingLine.price)})`
    : "غير محدد";

  const message =
    `🛍️ *طلب جديد من الفورم!*\n\n` +
    `👤 الاسم: ${customer.name}\n` +
    `📞 التليفون: ${customer.phone}\n` +
    `📍 العنوان: ${customer.address}\n\n` +
    `🧾 المنتجات:\n${itemLines}\n\n` +
    `🚚 التوصيل: ${shippingLineText}\n` +
    `💰 الإجمالي: ${money(total)}`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(
    phone
  )}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;

  try {
    await fetch(url);
  } catch (err) {
    // Never let a WhatsApp failure break order creation.
    console.error("WhatsApp notification failed:", err.message);
  }
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

    let shippingLine = null;
    if (shipping && shipping.zone_id && shipping.rate_name) {
      const authoritative = findAuthoritativeRate(shipping.zone_id, shipping.rate_name);
      if (authoritative) {
        shippingLine = {
          title: `${authoritative.zone_name} - ${authoritative.rate_name}`,
          price: authoritative.price,
        };
        draftOrder.shipping_line = shippingLine;
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

    const itemsSubtotal = items.reduce(
      (sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 0),
      0
    );
    const total = itemsSubtotal + (shippingLine ? Number(shippingLine.price) : 0);

    await sendWhatsAppNotification({ customer, items, shippingLine, total });

    res.status(200).json({ success: true, draft_order: orderData.draft_order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
