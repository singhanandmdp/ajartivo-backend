const express = require("express");

const { cleanText } = require("../config");
const { requireAuthenticatedUser } = require("../middleware/requireAuth");
const { requireSupabaseConfigured } = require("../middleware/requireConfig");
const {
    getDesignById,
    incrementDesignViews
} = require("../services/designService");
const { consumeToolEntitlement, ensureUserProfile } = require("../services/userService");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();

router.get("/tools/summary", requireSupabaseConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const profile = await ensureUserProfile(req.authUser);

    res.json({
        success: true,
        account: buildToolsAccount(profile)
    });
}));

router.post("/tools/consume", requireSupabaseConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const toolId = cleanText(req.body && req.body.tool_id).toLowerCase();
    if (!toolId) {
        throw createHttpError(400, "Tool ID is required.");
    }

    const profile = await consumeToolEntitlement(req.authUser, toolId);

    res.json({
        success: true,
        tool_id: toolId,
        account: buildToolsAccount(profile)
    });
}));

router.post("/designs/:designId/view", requireSupabaseConfigured, asyncHandler(async function (req, res) {
    const designId = cleanText(req.params && req.params.designId);
    if (!designId) {
        throw createHttpError(400, "Design ID is required.");
    }

    const design = await getDesignById(designId);
    if (!design) {
        throw createHttpError(404, "Design not found.");
    }

    const updated = await incrementDesignViews(design);

    res.json({
        success: true,
        design: buildDesignViewPayload(updated || design)
    });
}));

function buildToolsAccount(profile) {
    return {
        role: cleanText(profile && profile.role),
        premium_active: profile && profile.premium_active === true,
        active_plan_id: cleanText(profile && profile.active_plan_id),
        active_plan_name: cleanText(profile && profile.active_plan_name) || "Free",
        daily_ai_limit: Number(profile && profile.daily_ai_limit || 0),
        ai_generations_used_today: Number(profile && profile.ai_generations_used_today || 0),
        ai_remaining_today: Number(profile && profile.ai_remaining_today || 0),
        print_layout_limit: cleanText(profile && profile.print_layout_limit),
        tools_access: profile && profile.tools_access ? profile.tools_access : {}
    };
}

function buildDesignViewPayload(design) {
    return {
        id: cleanText(design && design.id),
        title: cleanText(design && design.title),
        views: Number(design && design.views || 0),
        downloads: Number(design && design.downloads || 0)
    };
}

module.exports = router;
