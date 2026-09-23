import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };

function structuredDataFrom(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
}

async function get(path, env = {}) {
  return worker.fetch(
    new Request(`https://solomap.app${path}`, { headers: { "user-agent": "Googlebot" } }),
    { SITE_ORIGIN: "https://solomap.app", ...env },
    ctx
  );
}

test("the digital subscription page does not opt into physical-product merchant listings", async () => {
  const homepage = await get("/");
  const homepageData = structuredDataFrom(await homepage.text());
  const software = homepageData.find((item) => item["@type"] === "SoftwareApplication");

  assert.equal(homepage.status, 200);
  assert.ok(software);
  assert.equal(homepageData.some((item) => item["@type"] === "Product"), false);
  assert.equal(software.offers.shippingDetails, undefined);
  assert.equal(software.offers.hasMerchantReturnPolicy, undefined);

  const plan = {
    planId: "solomap_pro_early_access_yearly",
    interval: "year",
    currency: "usd",
    amountCents: 2900,
    featureKeys: ["strategy_pyramid"],
    metadata: {
      deviceLimit: 5,
      refundDays: 37,
      customerDisplay: {
        en: { name: "SoloMap Pro", billingSuffix: "/ year", offerLabel: "Early access", summary: "One yearly plan." },
        zh: { name: "SoloMap Pro", billingSuffix: "/ 年", offerLabel: "早期计划", summary: "一个年度计划。" }
      },
      features: [{
        name: { en: "Roadmap", zh: "路线图" },
        free: { en: "Core", zh: "核心" },
        paid: { en: "Pro", zh: "专业版" }
      }]
    }
  };
  const pro = await get("/pro", {
    SOLOMAP_PASSPORT_PRODUCT_SECRET: "test-product-secret",
    SOLOMAP_PASSPORT_CATALOG_URL: `data:application/json,${encodeURIComponent(JSON.stringify({ ok: true, data: { plans: [plan] } }))}`
  });
  const proHtml = await pro.text();
  const proData = structuredDataFrom(proHtml);
  const webpage = proData.find((item) => item["@type"] === "WebPage");

  assert.equal(pro.status, 200);
  assert.equal(proData.some((item) => item["@type"] === "Product"), false);
  assert.equal(proData.some((item) => item["@type"] === "SoftwareApplication"), false);
  assert.equal(webpage.about["@type"], "SoftwareApplication");
  assert.equal("offers" in webpage.about, false);
  assert.match(proHtml, /class="pro-price">\$29\.00/);
});
