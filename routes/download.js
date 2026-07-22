const express = require("express");

const { cleanText, config } = require("../config");
const { requireAuthenticatedUser } = require("../middleware/requireAuth");
const { requireR2Configured, requireSupabaseConfigured } = require("../middleware/requireConfig");
const {
    incrementDesignDownloads,
    sendProtectedFile
} = require("../services/designService");
const { getDesignAccessSummary } = require("../services/accessService");
const { consumeUserEntitlement, ensureUserProfile, updateUserAvatar } = require("../services/userService");
const { isAllowedUploadExtension, uploadBufferToR2 } = require("../services/r2Service");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();
const rawAvatarUploadParser = express.raw({
    type: function () {
        return true;
    },
    limit: config.uploads.maxPreviewSizeBytes
});

router.get("/account/summary", requireSupabaseConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const profile = await ensureUserProfile(req.authUser);

    res.json({
        success: true,
        account: buildAccountPayload(profile)
    });
}));

router.get("/access/design/:designId", requireSupabaseConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const summary = await getDesignAccessSummary(req.authUser, req.params.designId);

    res.json({
        success: true,
        design: buildDesignPayload(summary.design),
        account: buildAccountPayload(summary.userProfile),
        access: summary.access,
        purchase: summary.purchase ? {
            id: cleanText(summary.purchase.id),
            payment_id: cleanText(summary.purchase.payment_id),
            created_at: cleanText(summary.purchase.created_at)
        } : null
    });
}));

router.get("/download/:designId", requireSupabaseConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const summary = await getDesignAccessSummary(req.authUser, req.params.designId);
    if (!summary.access || summary.access.allowed !== true) {
        throw createHttpError(403, summary.access && summary.access.message
            ? summary.access.message
            : "You are not allowed to download this design.");
    }

    await consumeUserEntitlement(summary.userProfile, summary.access.grant_type);
    await incrementDesignDownloads(summary.design);
    await sendProtectedFile(res, summary.design);
}));

router.post(
    "/account/avatar",
    requireSupabaseConfigured,
    requireR2Configured,
    requireAuthenticatedUser,
    rawAvatarUploadParser,
    asyncHandler(async function (req, res) {
        const fileName = decodeHeaderText(req.headers["x-file-name"]);
        const fileType = decodeHeaderText(req.headers["x-file-type"] || req.headers["content-type"]);
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

        if (!fileName) {
            throw createHttpError(400, "Avatar file name is missing.");
        }

        if (!buffer.length) {
            throw createHttpError(400, "Avatar file data is missing.");
        }

        if (!isAllowedUploadExtension(fileName, "avatar")) {
            throw createHttpError(400, "Profile image must be PNG, JPG, JPEG, or WEBP.");
        }

        if (buffer.length > config.uploads.maxPreviewSizeBytes) {
            throw createHttpError(400, `Profile image must be ${Math.round(config.uploads.maxPreviewSizeBytes / 1024 / 1024)} MB or smaller.`);
        }

        const upload = await uploadBufferToR2({
            uploadKind: "avatar",
            fileName: fileName,
            contentType: fileType,
            buffer: buffer
        });
        const profile = await updateUserAvatar(req.authUser, upload.publicUrl);

        res.json({
            success: true,
            avatar_url: cleanText(profile && profile.avatar_url) || upload.publicUrl,
            account: buildAccountPayload(profile)
        });
    })
);

function buildAccountPayload(profile) {
    return {
        id: cleanText(profile && profile.id),
        email: cleanText(profile && profile.email).toLowerCase(),
        first_name: cleanText(profile && profile.first_name),
        last_name: cleanText(profile && profile.last_name),
        address: cleanText(profile && profile.address),
        mobile_number: cleanText(profile && profile.mobile_number),
        avatar_url: cleanText(profile && profile.avatar_url),
        role: cleanText(profile && profile.role),
        is_banned: profile && profile.is_banned === true,
        is_premium: profile && profile.is_premium === true,
        premium_active: profile && profile.premium_active === true,
        active_plan_id: cleanText(profile && profile.active_plan_id),
        active_plan_name: cleanText(profile && profile.active_plan_name),
        premium_expiry: cleanText(profile && profile.premium_expiry),
        monthly_download_limit: Number(profile && profile.monthly_download_limit || 0),
        downloads_used_month: Number(profile && profile.downloads_used_month || 0),
        downloads_remaining_month: Number(profile && profile.downloads_remaining_month || 0),
        source_access: cleanText(profile && profile.source_access),
        library_access_percent: Number(profile && profile.library_access_percent || 0),
        daily_ai_limit: Number(profile && profile.daily_ai_limit || 0),
        ai_generations_used_today: Number(profile && profile.ai_generations_used_today || 0),
        ai_remaining_today: Number(profile && profile.ai_remaining_today || 0),
        tools_access: profile && profile.tools_access ? profile.tools_access : {},
        print_layout_limit: cleanText(profile && profile.print_layout_limit),
        free_download_limit: Number(profile && profile.free_download_limit || 0),
        free_download_count: Number(profile && profile.free_download_count || 0),
        free_download_remaining: Number(profile && profile.free_download_remaining || 0),
        premium_download_limit: Number(profile && profile.weekly_premium_download_limit || profile && profile.monthly_download_limit || 0),
        weekly_premium_download_count: Number(profile && profile.weekly_premium_download_count || 0),
        weekly_premium_remaining: Number(profile && profile.weekly_premium_remaining || 0),
        weekly_reset_date: cleanText(profile && profile.weekly_reset_date),
        premium_badge: cleanText(profile && profile.premium_badge)
    };
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

function buildDesignPayload(design) {
    return {
        id: cleanText(design && design.id),
        title: cleanText(design && design.title),
        price: Number(design && design.price || 0),
        is_free: design && design.is_free === true,
        is_premium: design && design.is_premium === true,
        download_enabled: Boolean(design && design.download_link)
    };
}

module.exports = router;
