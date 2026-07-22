const express = require("express");
const router = express.Router();

const { getSupabaseAdminClient } = require("../supabaseClient");

const BASE_URL = "https://www.ajartivo.in";
const STATIC_PAGES = [
  { path: "/", priority: "1.0" },
  { path: "/pages/search", priority: "0.8" },
  { path: "/about", priority: "0.7" },
  { path: "/contact", priority: "0.7" },
  { path: "/privacy", priority: "0.4" },
  { path: "/terms", priority: "0.4" },
  { path: "/refund", priority: "0.4" },
  { path: "/license", priority: "0.4" },
  { path: "/premium", priority: "0.6" }
];
const TOOL_PAGES = [
  "/tools/aj-pixel-enhancer",
  "/tools/aj-pixel-cut",
  "/tools/image-resizer",
  "/tools/image-converter",
  "/tools/aj-colour-converter",
  "/tools/aj-print-layout-pro"
];

router.get("/sitemap.xml", async function (_req, res) {
  try {
    const payload = await buildSitemapPayload();
    res.header("Content-Type", "application/xml; charset=utf-8");
    res.send(renderUrlSetXml(payload));
  } catch (error) {
    console.error("Sitemap generation failed:", error);
    res.status(500).send("Unable to generate sitemap");
  }
});

router.get("/image-sitemap.xml", async function (_req, res) {
  try {
    const payload = await buildSitemapPayload();
    res.header("Content-Type", "application/xml; charset=utf-8");
    res.send(renderImageUrlSetXml(payload));
  } catch (error) {
    console.error("Image sitemap generation failed:", error);
    res.status(500).send("Unable to generate image sitemap");
  }
});

async function buildSitemapPayload() {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("designs")
    .select("id, slug, title, description, image_url, category, updated_at, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const designs = Array.isArray(data) ? data : [];
  const seenDesignSlugs = new Set();
  const designEntries = [];

  designs.forEach(function (design) {
    const slug = normalizeSlug(design && design.slug, design && design.title);
    if (!slug || seenDesignSlugs.has(slug)) {
      return;
    }

    seenDesignSlugs.add(slug);
    designEntries.push({
      slug: slug,
      title: cleanText(design && design.title) || "AJartivo Design",
      description: cleanText(design && design.description),
      image_url: cleanText(design && design.image_url),
      category: cleanText(design && design.category).toUpperCase(),
      lastmod: toIsoString(design && (design.updated_at || design.created_at))
    });
  });

  const categoryEntries = buildCategoryEntries(designEntries);

  return {
    staticPages: STATIC_PAGES,
    toolPages: TOOL_PAGES,
    categoryEntries: categoryEntries,
    designEntries: designEntries
  };
}

function buildCategoryEntries(designEntries) {
  const categories = new Map();

  designEntries.forEach(function (design) {
    const category = cleanText(design.category).toUpperCase();
    if (!category) {
      return;
    }

    const existing = categories.get(category);
    if (!existing || existing.lastmod < design.lastmod) {
      categories.set(category, {
        category: category,
        lastmod: design.lastmod
      });
    }
  });

  return Array.from(categories.values()).map(function (item) {
    return {
      path: `/pages/search?category=${encodeURIComponent(item.category)}`,
      lastmod: item.lastmod,
      priority: "0.8",
      changefreq: "weekly"
    };
  });
}

function renderUrlSetXml(payload) {
  const entries = []
    .concat(payload.staticPages.map(function (item) {
      return {
        path: item.path,
        lastmod: new Date().toISOString(),
        priority: item.priority || "0.6",
        changefreq: "weekly"
      };
    }))
    .concat(payload.toolPages.map(function (path) {
      return {
        path: path,
        lastmod: new Date().toISOString(),
        priority: "0.7",
        changefreq: "weekly"
      };
    }))
    .concat(payload.categoryEntries)
    .concat(payload.designEntries.map(function (design) {
      return {
        path: `/product/${encodeURIComponent(design.slug)}`,
        lastmod: design.lastmod,
        priority: "0.9",
        changefreq: "weekly"
      };
    }));

  const urls = entries.map(function (item) {
    return `  <url>\n    <loc>${escapeXml(`${BASE_URL}${item.path}`)}</loc>\n    <lastmod>${escapeXml(item.lastmod)}</lastmod>\n    <changefreq>${escapeXml(item.changefreq || "weekly")}</changefreq>\n    <priority>${escapeXml(item.priority || "0.5")}</priority>\n  </url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

function renderImageUrlSetXml(payload) {
  const imageEntries = payload.designEntries.map(function (design) {
    const pageUrl = `${BASE_URL}/product/${encodeURIComponent(design.slug)}`;
    const imageUrl = cleanText(design.image_url);
    if (!imageUrl) {
      return "";
    }

    return `  <url>\n    <loc>${escapeXml(pageUrl)}</loc>\n    <lastmod>${escapeXml(design.lastmod)}</lastmod>\n    <image:image>\n      <image:loc>${escapeXml(imageUrl)}</image:loc>\n      <image:title>${escapeXml(design.title)}</image:title>\n      <image:caption>${escapeXml(design.description || design.title)}</image:caption>\n    </image:image>\n  </url>`;
  }).filter(Boolean).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${imageEntries}\n</urlset>`;
}

function normalizeSlug(value, fallbackTitle) {
  const base = slugify(cleanText(value) || cleanText(fallbackTitle));
  return base || slugify(cleanText(fallbackTitle)) || "design";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\'\"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanText(value) {
  return String(value || "").trim();
}

function toIsoString(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = router;
