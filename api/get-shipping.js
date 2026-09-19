// api/get-shipping.js
// Reads the merchant's own Shopify Delivery Profiles / Shipping Zones via GraphQL
// (the modern replacement for the legacy REST shipping_zones.json, which does not
// expose rates configured through Shopify's current "Shipping and delivery" UI).
// This way delivery options + prices always match what's configured in Shopify —
// no hardcoded price table to maintain in the code.

const API_VERSION = "2025-10";

// Optional Arabic display names for known zone/rate labels.
// If a zone or rate name isn't in this map, its original name is shown as-is.
// Tip: the simplest long-term fix is to just rename the zones themselves to
// Arabic directly in Shopify (Settings > Shipping and delivery) — then this
// map isn't needed at all, since we always echo Shopify's own zone name.
const ZONE_NAME_AR = {
  "cod cairo": "القاهرة",
  "cairo": "القاهرة",
  "giza": "الجيزة",
  "north egypt": "شمال مصر (بحري وسيناء)",
  "deep upper egypt": "جنوب الصعيد",
  "governments": "محافظات الدلتا",
  "middle egypt": "وسط الصعيد",
  "helwan": "حلوان",
  "6th october": "6 أكتوبر",
  "minya": "المنيا",
  "asia": "دول الخليج",
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

const DELIVERY_PROFILES_QUERY = `
  {
    deliveryProfiles(first: 20) {
      edges {
        node {
          profileLocationGroups {
            locationGroupZones(first: 50) {
              edges {
                node {
                  zone {
                    id
                    name
                  }
                  methodDefinitions(first: 20) {
                    edges {
                      node {
                        name
                        active
                        rateProvider {
                          __typename
                          ... on DeliveryRateDefinition {
                            price {
                              amount
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Fetch raw delivery-profile zone/rate data from Shopify (shared with create-draft-order.js).
async function fetchDeliveryZones(shop, accessToken) {
  const gqlRes = await fetch(
    `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: DELIVERY_PROFILES_QUERY }),
    }
  );

  if (!gqlRes.ok) {
    const text = await gqlRes.text();
    throw new Error(`Shopify GraphQL request failed: ${gqlRes.status} ${text}`);
  }

  const json = await gqlRes.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const zonesMap = new Map();

  const profileEdges = json.data?.deliveryProfiles?.edges || [];
  for (const profileEdge of profileEdges) {
    const groups = profileEdge.node.profileLocationGroups || [];
    for (const group of groups) {
      const zoneEdges = group.locationGroupZones?.edges || [];
      for (const ze of zoneEdges) {
        const zone = ze.node.zone;
        const methodEdges = ze.node.methodDefinitions?.edges || [];

        const rates = methodEdges
          .map((me) => me.node)
          .filter(
            (m) =>
              m.active &&
              m.rateProvider &&
              m.rateProvider.__typename === "DeliveryRateDefinition"
          )
          .map((m) => ({
            rate_name: m.name,
            price: m.rateProvider.price.amount,
          }));

        if (!rates.length) continue;

        if (!zonesMap.has(zone.id)) {
          zonesMap.set(zone.id, { zone_id: zone.id, zone_name: zone.name, rates: [] });
        }
        zonesMap.get(zone.id).rates.push(...rates);
      }
    }
  }

  return Array.from(zonesMap.values());
}

module.exports = async (req, res) => {
  try {
    const shop = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = await getAccessToken();
    const rawZones = await fetchDeliveryZones(shop, accessToken);

    const zones = rawZones.map((z) => ({
      zone_id: z.zone_id,
      zone_name: z.zone_name,
      zone_name_ar: translate(z.zone_name, ZONE_NAME_AR),
      rates: z.rates.map((r) => ({
        rate_name: r.rate_name,
        rate_name_ar: translate(r.rate_name, RATE_NAME_AR),
        price: r.price,
      })),
    }));

    res.status(200).json({ zones });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
