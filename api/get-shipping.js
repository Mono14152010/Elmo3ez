// api/get-shipping.js
//
// Delivery zones + prices, kept as a plain list right here so Mono can edit
// them anytime without touching Shopify at all — just change the numbers
// below and redeploy (GitHub → Vercel auto-deploys in ~1 minute).
//
// ⚠️ IMPORTANT: this same list also exists in api/create-draft-order.js
// (used there to double-check the price before creating the order, so a
// customer can't fake a cheaper delivery price from the browser).
// If you change a price here, change it there too.

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

module.exports = async (req, res) => {
  const zones = SHIPPING_ZONES.map((z) => ({
    zone_id: z.zone_id,
    zone_name: z.zone_name,
    zone_name_ar: z.zone_name,
    rates: z.rates.map((r) => ({
      rate_name: r.rate_name,
      rate_name_ar: r.rate_name,
      price: r.price,
    })),
  }));

  res.status(200).json({ zones });
};
