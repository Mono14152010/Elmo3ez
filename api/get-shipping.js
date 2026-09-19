// api/create-draft-order.js
// Creates a Shopify Draft Order from the submitted form data, including
// a shipping_line whose price is looked up server-side via Shopify's
// GraphQL deliveryProfiles query (so a customer can't tamper with the
// delivery price in the browser). Self-contained on purpose — no shared
// import from get-shipping.js — to avoid repeating an earlier deploy bug.

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

async function getAuthoritativeShippingRate(shop, accessToken, zoneId, rateName) {
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

  const profileEdges = json.data?.deliveryProfiles?.edges || [];
  for (const profileEdge of profileEdges) {
    const groups = profileEdge.node.profileLocationGroups || [];
    for (const group of groups) {
      const zoneEdges = group.locationGroupZones?.edges || [];
      for (const ze of zoneEdges) {
        const zone = ze.node.zone;
        if (String(zone.id) !== String(zoneId)) continue;

        const methodEdges = ze.node.methodDefinitions?.edges || [];
        const match = methodEdges
          .map((me) => me.node)
          .find(
            (m) =>
              m.active &&
              m.name === rateName &&
              m.rateProvider &&
              m.rateProvider.__typename === "DeliveryRateDefinition"
          );

        if (match) {
          return {
            zone_name: zone.name,
            rate_name: match.name,
            price: match.rateProvider.price.amount,
          };
        }
      }
    }
  }

  return null;
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
