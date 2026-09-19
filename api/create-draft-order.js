// api/create-draft-order.js
// Creates a Shopify Draft Order from the submitted form data, including
// a shipping_line whose price is looked up server-side from Shopify's
// own Shipping Zones (so a customer can't tamper with the delivery price
// in the browser).

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

async function getAuthoritativeShippingRate(shop, accessToken, zoneId, rateName) {
  const zonesRes = await fetch(
    `https://${shop}.myshopify.com/admin/api/${API_VERSION}/shipping_zones.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (!zonesRes.ok) {
    const text = await zonesRes.text();
    throw new Error(`Shopify shipping_zones fetch failed: ${zonesRes.status} ${text}`);
  }

  const data = await zonesRes.json();
  const zone = (data.shipping_zones || []).find((z) => String(z.id) === String(zoneId));
  if (!zone) return null;

  const allRates = [
    ...(zone.price_based_shipping_rates || []),
    ...(zone.weight_based_shipping_rates || []),
  ];
  const rate = allRates.find((r) => r.name === rateName);
  if (!rate) return null;

  return { zone_name: zone.name, rate_name: rate.name, price: rate.price };
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

    // Look up the real shipping price from Shopify itself — ignore any price
    // the browser might have sent, only trust zone_id + rate_name as a selector.
    if (shipping && shipping.zone_id && shipping.rate_name) {
      const authoritative = await getAuthoritativeShippingRate(
        shop,
        accessToken,
        shipping.zone_id,
        shipping.rate_name
      );
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
