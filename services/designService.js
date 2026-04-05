const fs = require("fs");
const path = require("path");

const {
    cleanText,
    config,
    ensureTrailingSeparator,
    isHttpUrl
} = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");

const DESIGN_TABLES = ["designs"];

async function getDesignById(designId) {
    const normalizedId = cleanText(designId);
    if (!normalizedId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();

    for (const tableName of DESIGN_TABLES) {
        const { data, error } = await supabase
            .from(tableName)
            .select("*")
            .eq("id", normalizedId)
            .maybeSingle();

        if (error) {
            if (isMissingRelationError(error)) {
                break;
            }

            throw error;
        }

        if (data) {
            return normalizeDesignRecord(data, tableName);
        }
    }

    return null;
}

function normalizeDesignRecord(record, sourceTable) {
    const design = record || {};
    const price = Number(design.price || 0);
    const normalizedPrice = Number.isFinite(price) ? price : 0;
    const isFree = design.is_free === true || normalizedPrice <= 0 && design.is_premium !== true && design.is_paid !== true;
    const isPremium = design.is_premium === true || (isFree !== true && (design.is_paid === true || normalizedPrice > 0));
    const paid = isPremium === true || normalizedPrice > 0;

    return {
        ...design,
        id: cleanText(design.id),
        source_table: cleanText(sourceTable) || "designs",
        title: cleanText(design.title || design.name) || "AJartivo Design",
        description: cleanText(design.description),
        price: normalizedPrice,
        is_free: isFree,
        is_premium: isPremium,
        is_paid: paid,
        download_link: cleanText(design.download_link || design.download || design.file_url),
        downloads: Number(design.downloads || 0) || 0,
        amount_in_paise: Math.round(Math.max(0, normalizedPrice) * 100)
    };
}

function isPaidDesign(design) {
    return Boolean(design && design.is_paid === true && design.amount_in_paise > 0) ||
        Number(design && design.amount_in_paise || 0) > 0;
}

async function incrementDesignDownloads(designOrId) {
    const design = typeof designOrId === "object" && designOrId
        ? designOrId
        : await getDesignById(designOrId);

    if (!design || !design.id) {
        return;
    }

    const supabase = getSupabaseAdminClient();
    const nextValue = Number(design.downloads || 0) + 1;
    const tableName = cleanText(design.source_table) || "designs";

    const { error } = await supabase
        .from(tableName)
        .update({ downloads: nextValue })
        .eq("id", design.id);

    if (error) {
        throw error;
    }
}

async function sendProtectedFile(res, design) {
    const downloadLink = cleanText(design && design.download_link);
    if (!downloadLink) {
        throw createHttpError(404, "Download file is not configured for this design.");
    }

    const downloadName = buildDownloadFileName(design, downloadLink);
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

    if (isHttpUrl(downloadLink)) {
        const remoteFile = await fetchRemoteDownloadFile(downloadLink);
        const contentType = cleanText(remoteFile.response.headers.get("content-type")) || "application/octet-stream";
        const arrayBuffer = await remoteFile.response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        res.status(200).send(Buffer.from(arrayBuffer));
        return;
    }

    const filePath = resolveLocalDownloadPath(downloadLink);
    if (!fs.existsSync(filePath)) {
        throw createHttpError(404, "Download file was not found on the server.");
    }

    await new Promise(function (resolve, reject) {
        res.download(filePath, downloadName, function (error) {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

function resolveLocalDownloadPath(downloadLink) {
    const rawPath = cleanText(downloadLink);
    const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(config.projectRoot, rawPath.replace(/^[/\\]+/, ""));

    const normalizedDownloadsRoot = ensureTrailingSeparator(config.downloadsRoot);
    const normalizedResolvedPath = path.resolve(resolvedPath);

    if (
        normalizedResolvedPath !== config.downloadsRoot &&
        !normalizedResolvedPath.startsWith(normalizedDownloadsRoot)
    ) {
        throw createHttpError(400, "Only files inside the downloads directory can be served.");
    }

    return normalizedResolvedPath;
}

function buildDownloadFileName(design, downloadLink) {
    const extension = path.extname(cleanText(downloadLink).split("?")[0].split("#")[0]) || "";
    const baseName = cleanText(design && design.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "ajartivo-file";

    return `aj-${baseName}${extension.toLowerCase()}`;
}

function isMissingRelationError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();

    return code === "42P01" || (message.includes("relation") && message.includes("does not exist"));
}

async function fetchRemoteDownloadFile(downloadLink) {
    const candidates = buildRemoteDownloadCandidates(downloadLink);
    let lastResponse = null;

    for (const candidate of candidates) {
        const response = await fetch(candidate.url, {
            redirect: "follow",
            headers: {
                "Accept": "*/*",
                "User-Agent": "AJartivo-Download-Proxy/1.0"
            }
        });

        if (!response.ok) {
            lastResponse = response;
            continue;
        }

        const contentType = cleanText(response.headers.get("content-type")).toLowerCase();
        if (candidate.expectBinary !== true || !contentType.includes("text/html")) {
            return {
                url: candidate.url,
                response: response
            };
        }

        lastResponse = response;
    }

    if (lastResponse) {
        throw createHttpError(502, `Remote file download failed with status ${lastResponse.status}.`);
    }

    throw createHttpError(502, "Remote file download failed.");
}

function buildRemoteDownloadCandidates(downloadLink) {
    const normalizedUrl = cleanText(downloadLink);
    const driveFileId = extractGoogleDriveFileId(normalizedUrl);

    if (driveFileId) {
        return [
            {
                url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveFileId)}&export=download&confirm=t`,
                expectBinary: true
            },
            {
                url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`,
                expectBinary: true
            },
            {
                url: normalizedUrl,
                expectBinary: true
            }
        ];
    }

    if (/dropbox\.com/i.test(normalizedUrl)) {
        const dropboxDirectUrl = normalizedUrl.includes("?")
            ? normalizedUrl.replace(/[?&]dl=\d+/i, "").concat(normalizedUrl.match(/[?&]/) ? "&dl=1" : "?dl=1")
            : `${normalizedUrl}?dl=1`;

        return [
            { url: dropboxDirectUrl, expectBinary: true },
            { url: normalizedUrl, expectBinary: true }
        ];
    }

    return [{ url: normalizedUrl, expectBinary: false }];
}

function extractGoogleDriveFileId(value) {
    const normalizedValue = cleanText(value);
    if (!/drive\.google\.com|drive\.usercontent\.google\.com/i.test(normalizedValue)) {
        return "";
    }

    const filePathMatch = normalizedValue.match(/\/file\/d\/([^/?#]+)/i);
    if (filePathMatch && filePathMatch[1]) {
        return cleanText(filePathMatch[1]);
    }

    try {
        const parsedUrl = new URL(normalizedValue);
        return cleanText(parsedUrl.searchParams.get("id"));
    } catch (_error) {
        return "";
    }
}

module.exports = {
    buildDownloadFileName,
    getDesignById,
    incrementDesignDownloads,
    isPaidDesign,
    sendProtectedFile
};
