const express = require("express");

const { cleanText, config, isHttpUrl } = require("../config");
const { requireR2Configured, requireSupabaseConfigured } = require("../middleware/requireConfig");
const { requireAdminUser, requireAuthenticatedUser } = require("../middleware/requireAuth");
const { listLatestDesigns, saveDesignRecord } = require("../services/adminDesignService");
const {
    grantPremiumMembership,
    listAdminUsers,
    listPremiumPlans,
    revokePremiumMembership,
    setUserBanState
} = require("../services/adminMembershipService");
const { inferCategory, isAllowedUploadExtension, uploadBufferToR2 } = require("../services/r2Service");
const { asyncHandler, createHttpError } = require("../utils/http");
const { parseMultipartRequest } = require("../utils/multipart");

const router = express.Router();

const rawUploadParser = express.raw({
    type: function () {
        return true;
    },
    limit: config.uploads.maxFileSizeBytes
});

router.get("/designs", requireSupabaseConfigured, asyncHandler(async function (req, res) {
    const items = await listLatestDesigns(req.query && req.query.limit);

    res.json({
        success: true,
        designs: items
    });
}));

router.get("/plans", asyncHandler(async function (_req, res) {
    const plans = await listPremiumPlans();

    res.json({
        success: true,
        plans: plans
    });
}));

router.get("/admin/users", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const items = await listAdminUsers(req.query && req.query.limit);

    res.json({
        success: true,
        users: items
    });
}));

router.post("/admin/subscriptions/grant", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const userId = cleanText(req.body && req.body.user_id);
    const planId = cleanText(req.body && req.body.plan_id);

    if (!userId) {
        throw createHttpError(400, "User ID is required.");
    }

    const user = await grantPremiumMembership(userId, planId);

    res.json({
        success: true,
        user: user
    });
}));

router.post("/admin/subscriptions/revoke", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const userId = cleanText(req.body && req.body.user_id);

    if (!userId) {
        throw createHttpError(400, "User ID is required.");
    }

    const profile = await revokePremiumMembership(userId);

    res.json({
        success: true,
        result: {
            profile: profile
        }
    });
}));

router.post("/admin/users/:id/ban", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const userId = cleanText(req.params && req.params.id);
    const isBanned = req.body && req.body.is_banned === true;

    if (!userId) {
        throw createHttpError(400, "User ID is required.");
    }

    const user = await setUserBanState(userId, isBanned);

    res.json({
        success: true,
        user: user
    });
}));

router.post(
    "/upload",
    requireSupabaseConfigured,
    requireR2Configured,
    requireAuthenticatedUser,
    requireAdminUser,
    rawUploadParser,
    asyncHandler(async function (req, res) {
        const multipart = parseMultipartRequest(req);
        const multipartFile = multipart.files && multipart.files.file;
        const uploadKind = cleanUploadKind(
            multipart.fields && multipart.fields.uploadKind ||
            req.headers["x-upload-kind"]
        );
        const fileName = decodeHeaderText(
            multipartFile && multipartFile.fileName ||
            req.headers["x-file-name"]
        );
        const fileType = decodeHeaderText(
            multipartFile && multipartFile.contentType ||
            req.headers["x-file-type"] ||
            req.headers["content-type"]
        );
        const buffer = multipartFile && Buffer.isBuffer(multipartFile.buffer)
            ? multipartFile.buffer
            : Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.alloc(0);

        if (!fileName) {
            throw createHttpError(400, "Uploaded file name is missing.");
        }

        if (!buffer.length) {
            throw createHttpError(400, "File data is missing.");
        }

        if (!isAllowedUploadExtension(fileName, uploadKind)) {
            throw createHttpError(
                400,
                uploadKind === "preview"
                    ? "Preview image must be PNG, JPG, JPEG, or WEBP."
                    : "Design file must be PNG, JPG, JPEG, ZIP, PSD, AI, or CDR."
            );
        }

        validateUploadSize(buffer.length, uploadKind);

        const upload = await uploadBufferToR2({
            uploadKind: uploadKind,
            fileName: fileName,
            contentType: fileType,
            buffer: buffer
        });

        res.json({
            success: true,
            file_name: upload.fileName,
            file_url: upload.publicUrl,
            category: upload.category
        });
    })
);

router.post(
    "/save",
    requireSupabaseConfigured,
    requireAuthenticatedUser,
    requireAdminUser,
    asyncHandler(async function (req, res) {
        const payload = req.body || {};
        const title = cleanText(payload.title);
        const price = normalizePrice(payload.price);
        const imageUrl = cleanText(payload.image_url);
        const fileUrl = cleanText(payload.file_url);
        const category = cleanText(payload.category).toUpperCase() || inferCategory(fileUrl || title);
        const description = cleanText(payload.description);
        const tags = normalizeTags(payload.tags);
        const isPremium = payload.is_premium === true;

        if (!title) {
            throw createHttpError(400, "Title is required.");
        }

        if (!fileUrl || !isHttpUrl(fileUrl)) {
            throw createHttpError(400, "A valid uploaded file URL or manual link is required.");
        }

        if (!imageUrl || !isHttpUrl(imageUrl)) {
            throw createHttpError(400, "A valid preview image URL is required.");
        }

        if (price < 0) {
            throw createHttpError(400, "Price must be zero or more.");
        }

        const savedRecord = await saveDesignRecord({
            title: title,
            price: price,
            image_url: imageUrl,
            file_url: fileUrl,
            category: category,
            description: description,
            tags: tags,
            is_premium: isPremium
        });

        res.json({
            success: true,
            design: savedRecord
        });
    })
);

function cleanUploadKind(value) {
    return cleanText(value).toLowerCase() === "preview" ? "preview" : "design";
}

function validateUploadSize(sizeInBytes, uploadKind) {
    const maxBytes = uploadKind === "preview"
        ? config.uploads.maxPreviewSizeBytes
        : config.uploads.maxFileSizeBytes;

    if (Number(sizeInBytes) > maxBytes) {
        throw createHttpError(
            400,
            uploadKind === "preview"
                ? `Preview image must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`
                : `Design file must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`
        );
    }
}

function decodeHeaderText(value) {
    const normalized = cleanText(Array.isArray(value) ? value[0] : value);
    if (!normalized) {
        return "";
    }

    try {
        return decodeURIComponent(normalized);
    } catch (_error) {
        return normalized;
    }
}

function normalizePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }

    return Math.round(parsed);
}

function normalizeTags(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(function (item) {
            return cleanText(item);
        })
        .filter(Boolean)
        .filter(function (item, index, list) {
            return list.indexOf(item) === index;
        });
}

module.exports = router;
