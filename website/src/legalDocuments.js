const DEFAULT_LEGAL_BASE_URL = "https://laws.szlk.ai";
const PRODUCT_ID = "solomap";

export const legalRoutes = [
  { slug: "terms-of-service", type: "terms_of_service", label: { en: "Terms of Service", zh: "服务条款" } },
  { slug: "privacy-policy", type: "privacy_policy", label: { en: "Privacy Policy", zh: "隐私政策" } },
  { slug: "cookie-policy", type: "cookie_policy", label: { en: "Cookie Policy", zh: "Cookie 政策" } },
  { slug: "refund-policy", type: "refund_cancellation_policy", label: { en: "Refund Policy", zh: "退款政策" } },
  { slug: "data-rights", type: "data_rights_notice", label: { en: "Data Rights", zh: "数据权利" } },
  { slug: "do-not-sell", type: "do_not_sell_share_notice", label: { en: "Do Not Sell or Share", zh: "不出售或分享" } },
  { slug: "ai-disclaimer", type: "ai_entertainment_disclaimer", label: { en: "AI Disclaimer", zh: "AI 免责声明" } },
];

export const legalSupplementRoute = {
  slug: "legal-supplement",
  label: { en: "Product Legal Supplement", zh: "产品法律补充说明" },
};

export function findLegalRoute(pathname) {
  const normalized = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  const locale = normalized.startsWith("/zh/") ? "zh" : "en";
  const slug = normalized.replace(/^\/zh\//, "").replace(/^\//, "");
  const route = legalRoutes.find((item) => item.slug === slug);
  if (route) return { ...route, locale, supplement: false };
  if (slug === legalSupplementRoute.slug) {
    return { ...legalSupplementRoute, locale, supplement: true };
  }
  return null;
}

export function legalPath(slug, locale) {
  return `${locale === "zh" ? "/zh" : ""}/${slug}`;
}

export function alternateLegalPath(slug, locale) {
  return legalPath(slug, locale === "zh" ? "en" : "zh");
}

function legalLocale(locale) {
  return locale === "zh" ? "zh-CN" : "en";
}

async function fetchLegalApi(env, path) {
  const baseUrl = env?.SZLKLAWS_BASE_URL || DEFAULT_LEGAL_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`SZLKlaws request failed: ${response.status} ${path}`);
  }
  const payload = await response.json();
  if (!payload.success) {
    throw new Error(payload.error?.message || `SZLKlaws returned an error for ${path}`);
  }
  return payload;
}

export async function getLegalContent(env, route) {
  const query = new URLSearchParams({ product: PRODUCT_ID, locale: legalLocale(route.locale) });
  if (route.supplement) {
    const payload = await fetchLegalApi(env, `/api/legal/product-supplement?${query}`);
    if (payload.supplement?.product?.id !== PRODUCT_ID) {
      throw new Error("SZLKlaws returned a legal supplement for the wrong product");
    }
    return payload.supplement;
  }
  query.set("type", route.type);
  const payload = await fetchLegalApi(env, `/api/legal/document?${query}`);
  if (payload.document?.product?.id !== PRODUCT_ID) {
    throw new Error("SZLKlaws returned a legal document for the wrong product");
  }
  return payload.document;
}
