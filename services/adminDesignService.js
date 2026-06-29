const { createHttpError } = require("../utils/http");
const { cleanText, config, isHttpUrl } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");

async function listLatestDesigns(limit) {
    const supabase = getSupabaseAdminClient();
    const requestedLimit = Number(limit || 8);
    const maxItems = Math.min(1000, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 8));

    for (const tableName of config.supabase.designTables) {
        const result = await supabase
            .from(tableName)
            .select("*")
            .order("created_at", { ascending: false })
            .limit(maxItems);

        if (!result.error && Array.isArray(result.data) && result.data.length) {
            return result.data.map(function (item) {
                return normalizeDesignRecord(item, tableName);
            });
        }

        if (!result.error && Array.isArray(result.data)) {
            continue;
        }

        if (isMissingRelationError(result.error)) {
            continue;
        }

        throw result.error;
    }

    return [];
}

async function saveDesignRecord(payload) {
    const normalized = normalizeCreatePayload(payload);
    const supabase = getSupabaseAdminClient();
    normalized.slug = await resolveUniqueSlug(supabase, normalized.slug || normalized.title);
    let lastError = null;

    for (const tableName of config.supabase.designTables) {
        for (const record of buildInsertPayloads(normalized)) {
            const result = await supabase
                .from(tableName)
                .insert(record)
                .select("*")
                .single();

            if (!result.error && result.data) {
                return normalizeDesignRecord(result.data, tableName);
            }

            if (isMissingColumnError(result.error)) {
                lastError = result.error;
                continue;
            }

            if (isMissingRelationError(result.error)) {
                lastError = result.error;
                break;
            }

            throw result.error;
        }
    }

    if (lastError) {
        throw lastError;
    }

    throw createHttpError(500, "Unable to save the design record in Supabase.");
}

function normalizeCreatePayload(payload) {
    const title = cleanText(payload && payload.title);
    const price = normalizePrice(payload && payload.price);
    const imageUrl = cleanText(payload && (payload.image_url || payload.preview_url || payload.image || payload.previewUrl));
    const fileUrl = cleanText(payload && (payload.file_url || payload.download_link || payload.download_url || payload.downloadUrl || payload.download));
    const category = cleanText(payload && payload.category).toUpperCase() || "FILE";
    const description = cleanText(payload && payload.description);
    const tags = normalizeTags(payload && payload.tags, title);
    const isPremium = price > 0;
    const slug = normalizeSlug(payload && payload.slug, title);

    if (!title) {
        throw createHttpError(400, "Title is required.");
    }

    if (!fileUrl || !isHttpUrl(fileUrl)) {
        throw createHttpError(400, "A valid file URL is required.");
    }

    if (!imageUrl || !isHttpUrl(imageUrl)) {
        throw createHttpError(400, "A valid preview image URL is required.");
    }

    return {
        title: title.slice(0, 160),
        slug: slug,
        price: price,
        image_url: imageUrl,
        file_url: fileUrl,
        category: category,
        description: description || buildDefaultDescription(),
        tags: tags,
        is_premium: isPremium,
        is_free: price <= 0,
        created_at: new Date().toISOString()
    };
}

async function resolveUniqueSlug(supabase, value) {
    const baseSlug = slugify(cleanText(value)) || "design";

    try {
        const result = await supabase.from("designs").select("id,slug,title");
        if (result.error || !Array.isArray(result.data)) {
            return baseSlug;
        }

        const existingSlugs = new Set(
            result.data
                .map(function (item) {
                    return slugify(cleanText(item && (item.slug || item.title || item.name)));
                })
                .filter(Boolean)
        );

        let nextSlug = baseSlug;
        let counter = 1;
        while (existingSlugs.has(nextSlug)) {
            nextSlug = `${baseSlug}-${counter}`;
            counter += 1;
        }

        return nextSlug;
    } catch (_error) {
        return baseSlug;
    }
}

function buildInsertPayloads(payload) {
    return [
        {
            title: payload.title,
            slug: payload.slug,
            price: payload.price,
            image_url: payload.image_url,
            download_link: payload.download_link || payload.file_url,
            category: payload.category,
            description: payload.description,
            tags: payload.tags,
            created_at: payload.created_at,
            image: payload.image_url,
            is_premium: payload.price > 0,
            is_paid: payload.price > 0,
            is_free: payload.price <= 0
        },
        {
            title: payload.title,
            price: payload.price,
            slug: payload.slug,
            image: payload.image_url,
            download_link: payload.file_url,
            is_premium: payload.price > 0,
            category: payload.category,
            description: payload.description,
            tags: payload.tags,
            created_at: payload.created_at,
            is_paid: payload.price > 0,
            is_free: payload.price <= 0
        },
        {
            title: payload.title,
            slug: payload.slug,
            price: payload.price,
            image: payload.image_url,
            download_link: payload.file_url,
            is_premium: payload.price > 0,
            description: payload.description,
            tags: payload.tags,
            is_paid: payload.price > 0,
            is_free: payload.price <= 0,
            created_at: payload.created_at
        }
    ];
}

function normalizeDesignRecord(record, tableName) {
    const item = record || {};
    const rawPrice = item.price;
    const hasExplicitPrice = rawPrice !== null && typeof rawPrice !== "undefined" && String(rawPrice).trim() !== "";
    const normalizedPrice = normalizePrice(item.price);
    const slug = normalizeSlug(item.slug, item.title || item.name);
    const isPaid = hasExplicitPrice
        ? normalizedPrice > 0
        : item.is_premium === true || item.is_paid === true || normalizedPrice > 0;
    return {
        id: String(item.id || "").trim(),
        source_table: cleanText(tableName),
        title: cleanText(item.title || item.name) || "Untitled Design",
        slug: slug,
        price: normalizedPrice,
        description: cleanText(item.description),
        image_url: cleanText(item.image_url || item.image),
        download_link: cleanText(item.download_link || item.download || item.downloadUrl || item.file_url),
        tags: normalizeTags(item.tags, item.title || item.name),
        category: cleanText(item.category).toUpperCase() || "FILE",
        is_free: isPaid ? false : (hasExplicitPrice ? normalizedPrice <= 0 : item.is_free === true || (item.is_premium !== true && item.is_paid !== true)),
        is_premium: isPaid,
        is_paid: isPaid,
        created_at: cleanText(item.created_at) || new Date().toISOString()
    };
}

function isMissingColumnError(error) {
    const message = readErrorMessage(error);
    const code = cleanText(error && error.code).toUpperCase();
    return (
        code === "PGRST204" ||
        code === "42703" ||
        (message.includes("column") && message.includes("does not exist")) ||
        (message.includes("could not find the") && message.includes("column"))
    );
}

function isMissingRelationError(error) {
    const message = readErrorMessage(error);
    const code = cleanText(error && error.code).toUpperCase();
    return code === "42P01" || message.includes("relation") && message.includes("does not exist");
}

function readErrorMessage(error) {
    return cleanText(error && (error.message || error.details || error.hint)).toLowerCase();
}

function normalizePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }

    return Math.round(parsed);
}

function normalizeTags(value, fallbackTitle) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
        ? value.split(",")
        : [];

    const tags = source
        .map(function (item) {
            return cleanText(item);
        })
        .filter(Boolean)
        .filter(function (item, index, list) {
            return list.indexOf(item) === index;
        });

    if (tags.length) {
        return tags;
    }

    const fallback = cleanText(fallbackTitle);
    return fallback ? [fallback] : [];
}

function normalizeSlug(value, fallbackTitle) {
    return slugify(cleanText(value) || cleanText(fallbackTitle)) || slugify(cleanText(fallbackTitle)) || "design";
}

function slugify(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function buildDefaultDescription() {
    return "High-quality design file with clean and professional layout.\nEasy to use and suitable for personal, business, and print purposes.\n\nInstant download available after login.";
}

module.exports = {
    listLatestDesigns,
    normalizeDesignRecord,
    saveDesignRecord
};

