const express = require("express");
const router = express.Router();

const { getSupabaseAdminClient } = require("../supabaseClient");

const BASE_URL = "https://www.ajartivo.in";

router.get("/sitemap.xml", async (req, res) => {
  try {
    const supabase = getSupabaseAdminClient();

    const { data: designs, error } = await supabase
      .from("designs")
      .select("slug, updated_at, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return res.status(500).send("Unable to generate sitemap");
    }

    const staticPages = [
      "",
      "/products",
      "/categories",
      "/pricing",
      "/contact",
      "/about",
      "/privacy-policy",
      "/terms-and-conditions",
      "/tools/background-remover",
      "/tools/image-enhancer",
      "/tools/layout-pro"
    ];

    let urls = "";

    staticPages.forEach((page) => {
      urls += `
      <url>
        <loc>${BASE_URL}${page}</loc>
        <changefreq>weekly</changefreq>
        <priority>${page === "" ? "1.0" : "0.8"}</priority>
      </url>`;
    });

    designs.forEach((design) => {
      const lastmod =
        design.updated_at || design.created_at || new Date().toISOString();

      urls += `
      <url>
        <loc>${BASE_URL}/product/${design.slug}</loc>
        <lastmod>${new Date(lastmod).toISOString()}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.9</priority>
      </url>`;
    });

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.header("Content-Type", "application/xml");
    res.send(sitemap);

  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

module.exports = router;