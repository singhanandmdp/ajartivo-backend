const express = require("express");

const { cleanText, config, isHttpUrl } = require("../config");
const { requireR2Configured, requireSupabaseConfigured } = require("../middleware/requireConfig");
const { requireAdminUser, requireAuthenticatedUser } = require("../middleware/requireAuth");
const { listLatestDesigns, saveDesignRecord } = require("../services/adminDesignService");
const { inferCategory, isAllowedUploadExtension, uploadBufferToR2 } = require("../services/r2Service");
const {
    activatePremiumMembership,
    ensureUserProfile,
    getUserAdminSummary,
    listUsersForAdmin,
    revokePremiumMembership,
    setUserBanState
} = require("../services/userService");
const { getPlanById, listPlans } = require("../services/planService");
const { getSupabaseAdminClient } = require("../supabaseClient");
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

router.get("/admin/overview", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (_req, res) {
    const users = await listUsersForAdmin(100);
    const plans = await listPlans();
    const totals = users.reduce(function (summary, user) {
        summary.users += 1;
        if (user.premium_active === true) {
            summary.premium_active += 1;
        }
        if (user.is_banned === true) {
            summary.banned += 1;
        }
        return summary;
    }, {
        users: 0,
        premium_active: 0,
        banned: 0
    });

    res.json({
        success: true,
        overview: {
            totals: totals,
            plans: plans
        }
    });
}));

router.get("/admin/users", requireSupabaseConfigured, asyncHandler(async function (req, res) {
    const users = await listUsersForAdmin(req.query && req.query.limit);

    res.json({
        success: true,
        users: users
    });
}));

router.get("/admin/users/:userId", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const summary = await getUserAdminSummary(req.params.userId);
    if (!summary) {
        throw createHttpError(404, "User not found.");
    }

    res.json({
        success: true,
        user: summary.profile,
        subscriptions: summary.subscriptions
    });
}));

router.post("/admin/users/:userId/ban", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const updatedUser = await setUserBanState(req.params.userId, req.body && req.body.is_banned === true);

    res.json({
        success: true,
        user: updatedUser
    });
}));

router.post("/admin/subscriptions/grant", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const userId = cleanText(req.body && req.body.user_id);
    const planId = cleanText(req.body && req.body.plan_id);
    const plan = await getPlanById(planId);

    if (!userId || !plan) {
        throw createHttpError(400, "Valid user ID and plan ID are required.");
    }

    const targetUser = await getTargetAuthUser(userId);
    if (!targetUser) {
        throw createHttpError(404, "Target user was not found.");
    }

    const updatedUser = await activatePremiumMembership(targetUser, plan, {
        grantedBy: cleanText(req.authUser && req.authUser.id),
        metadata: {
            source: "admin_manual_grant"
        }
    });

    res.json({
        success: true,
        user: updatedUser
    });
}));

router.post("/admin/subscriptions/revoke", requireSupabaseConfigured, requireAuthenticatedUser, requireAdminUser, asyncHandler(async function (req, res) {
    const userId = cleanText(req.body && req.body.user_id);
    if (!userId) {
        throw createHttpError(400, "User ID is required.");
    }

    const result = await revokePremiumMembership(userId);

    res.json({
        success: true,
        result: result
    });
}));

router.post(
    "/admin/upload",
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
    "/admin/designs",
    requireSupabaseConfigured,
    requireAuthenticatedUser,
    requireAdminUser,
    asyncHandler(async function (req, res) {
        const payload = req.body || {};
        const title = cleanText(payload.title);
        const slug = cleanText(payload.slug) || title;
        const price = normalizePrice(payload.price);
        const imageUrl = cleanText(payload.image_url || payload.preview_url || payload.image || payload.previewUrl);
        const fileUrl = cleanText(payload.file_url || payload.download_link || payload.download_url || payload.downloadUrl || payload.download);
        const category = cleanText(payload.category).toUpperCase() || inferCategory(fileUrl || title);
        const description = cleanText(payload.description);
        const tags = normalizeTags(payload.tags);
        const isPremium = price > 0;

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
            slug: slug,
            price: price,
            image_url: imageUrl,
            download_link: fileUrl,
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

async function getTargetAuthUser(userId) {
    const profile = await getUserAdminSummary(userId);
    if (!profile || !profile.profile) {
        return null;
    }

    const user = profile.profile;
    return {
        id: cleanText(user.id),
        email: cleanText(user.email).toLowerCase(),
        user_metadata: {
            full_name: cleanText(user.name),
            first_name: cleanText(user.first_name),
            last_name: cleanText(user.last_name),
            address: cleanText(user.address),
            mobile_number: cleanText(user.mobile_number)
        }
    };
}

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

