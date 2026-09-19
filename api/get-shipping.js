// api/get-shipping.js
// Reads the merchant's own Shopify Shipping Zones (Settings > Shipping and delivery)
// so delivery options + prices always match what's configured in Shopify —
// no hardcoded price table to maintain in the code.

const API_VERSION = "2025-10";

// Optional Arabic display names for known zone/rate labels.
// If a zone or rate name isn't in this map, its original (English) name is shown as-is.
const ZONE_NAME_AR = {
  "cairo": "القاهرة",
  "giza": "الجيزة",
  "rest of egypt": "باقي المحافظات",
  "other governorates": "باقي المحافظات",
};

const RATE_NAME_AR = {
  "express": "اكسبريس",
  "standard": "ستاندرد",
};

function translate(name, map) {
  const key = (name || "").trim().toLowerCase();
  return map[key] || name;
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
  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();

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

    const zones = (data.shipping_zones || [])
      // Skip zones with no rates configured (nothing to offer the customer)
      .filter(
        (z) =>
          (z.price_based_shipping_rates && z.price_based_shipping_rates.length) ||
          (z.weight_based_shipping_rates && z.weight_based_shipping_rates.length)
      )
      .map((z) => {
        const priceRates = (z.price_based_shipping_rates || []).map((r) => ({
          rate_name: r.name,
          rate_name_ar: translate(r.name, RATE_NAME_AR),
          price: r.price,
        }));
        const weightRates = (z.weight_based_shipping_rates || []).map((r) => ({
          rate_name: r.name,
          rate_name_ar: translate(r.name, RATE_NAME_AR),
          price: r.price,
        }));

        return {
          zone_id: z.id,
          zone_name: z.name,
          zone_name_ar: translate(z.name, ZONE_NAME_AR),
          rates: [...priceRates, ...weightRates],
        };
      });

    // TEMP DEBUG — remove this line once shipping zones show up correctly.
    res.status(200).json({ zones, debug_raw: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
