// lib/shopify-auth.js

let cachedToken = null;
let tokenExpiresAt = null;

export async function getShopifyAccessToken() {
  // لو التوكن موجود وسارٍ، استخدمه
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const shopName = process.env.SHOPIFY_SHOP_NAME;

  if (!clientId || !clientSecret || !shopName) {
    throw new Error('Missing Shopify credentials in environment variables');
  }

  try {
    const response = await fetch(
      `https://${shopName}.myshopify.com/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.statusText}`);
    }

    const data = await response.json();

    // خزّن التوكن لمدة 59 دقيقة (التوكن بتاع Shopify صلاحيته ساعة)
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + 59 * 60 * 1000;

    return cachedToken;
  } catch (error) {
    console.error('Error fetching Shopify access token:', error);
    throw error;
  }
}
