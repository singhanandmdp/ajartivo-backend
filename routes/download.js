const express = require("express");

const { cleanText } = require("../config");
const { requireAuthenticatedUser } = require("../middleware/requireAuth");
const { requireSupabaseConfigured } = require("../middleware/requireConfig");
const {
    incrementDesignDownloads,
    sendProtectedFile
} = require("../services/designService");
const { getDesignAccessSummary } = require("../services/accessService");
const { consumeUserEntitlement, ensureUserProfile } = require("../services/userService");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();

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

function buildAccountPayload(profile) {
    return {
        id: cleanText(profile && profile.id),
        email: cleanText(profile && profile.email).toLowerCase(),
        first_name: cleanText(profile && profile.first_name),
        last_name: cleanText(profile && profile.last_name),
        address: cleanText(profile && profile.address),
        mobile_number: cleanText(profile && profile.mobile_number),
        is_premium: profile && profile.is_premium === true,
        premium_active: profile && profile.premium_active === true,
        premium_expiry: cleanText(profile && profile.premium_expiry),
        free_download_count: Number(profile && profile.free_download_count || 0),
        free_download_remaining: Number(profile && profile.free_download_remaining || 0),
        weekly_premium_download_count: Number(profile && profile.weekly_premium_download_count || 0),
        weekly_premium_remaining: Number(profile && profile.weekly_premium_remaining || 0),
        weekly_reset_date: cleanText(profile && profile.weekly_reset_date),
        premium_badge: cleanText(profile && profile.premium_badge)
    };
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
