const { cleanText } = require("../config");
const { getDesignById } = require("./designService");
const { findExistingPurchase } = require("./purchaseService");
const { ensureUserProfile } = require("./userService");
const { createHttpError } = require("../utils/http");

async function getDesignAccessSummary(authUser, designId) {
    const userProfile = await ensureUserProfile(authUser);
    const design = await getDesignById(designId);

    if (!design) {
        throw createHttpError(404, "Design not found.");
    }

    const purchase = await findExistingPurchase(authUser, design.id);
    const access = buildDesignAccessDecision({
        userProfile: userProfile,
        design: design,
        purchase: purchase
    });

    return {
        design: design,
        userProfile: userProfile,
        purchase: purchase,
        access: access
    };
}

function buildDesignAccessDecision(context) {
    const userProfile = context && context.userProfile ? context.userProfile : {};
    const design = context && context.design ? context.design : {};
    const purchase = context && context.purchase ? context.purchase : null;
    const premiumActive = userProfile.premium_active === true;
    const planRemaining = Number(userProfile.downloads_remaining_month || userProfile.weekly_premium_remaining || 0);
    const planLimit = Number(
        userProfile.monthly_download_limit ||
        userProfile.weekly_premium_download_limit ||
        userProfile.premium_download_limit ||
        0
    );
    const canBuy = design.is_free === true ? false : Number(design.amount_in_paise || 0) > 0;

    if (userProfile.is_banned === true) {
        return createAccessDecision({
            allowed: false,
            grantType: "none",
            status: "banned",
            message: "This account is currently banned from downloads.",
            canBuy: false,
            canUpgrade: false,
            remainingDownloads: 0
        });
    }

    if (design.is_free === true) {
        return createAccessDecision({
            allowed: true,
            grantType: "free_design",
            status: "free",
            message: "Free design ready to download.",
            canBuy: false,
            canUpgrade: premiumActive !== true,
            freeRemaining: Number(userProfile.free_download_remaining),
            planRemaining: planRemaining
        });
    }

    if (purchase) {
        return createAccessDecision({
            allowed: true,
            grantType: "purchased",
            status: "purchased",
            message: "Purchase confirmed. This design is unlocked for your account.",
            canBuy: false,
            canUpgrade: premiumActive !== true,
            freeRemaining: Number(userProfile.free_download_remaining),
            planRemaining: planRemaining
        });
    }

    if (premiumActive === true && (planLimit < 0 || planRemaining > 0)) {
        return createAccessDecision({
            allowed: true,
            grantType: "premium_plan",
            status: "premium",
            message: planLimit < 0
                ? `${cleanText(userProfile.active_plan_name) || "Premium"} gives you unlimited premium downloads.`
                : `${cleanText(userProfile.active_plan_name) || "Premium"} gives you ${planRemaining} premium downloads remaining this month.`,
            canBuy: canBuy,
            canUpgrade: false,
            freeRemaining: Number(userProfile.free_download_remaining),
            planRemaining: planRemaining
        });
    }

    if (premiumActive === true && planLimit >= 0 && planRemaining <= 0) {
        return createAccessDecision({
            allowed: false,
            grantType: "none",
            status: "premium_limit_reached",
            message: "Your premium download limit for this month has been reached. Buy this design or wait for the next cycle.",
            canBuy: canBuy,
            canUpgrade: false,
            freeRemaining: Number(userProfile.free_download_remaining),
            planRemaining: 0
        });
    }

    return createAccessDecision({
        allowed: false,
        grantType: "none",
        status: "purchase_required",
        message: "Buy this design or upgrade to an active premium plan to continue.",
        canBuy: canBuy,
        canUpgrade: true,
        freeRemaining: Number(userProfile.free_download_remaining),
        planRemaining: planRemaining
    });
}

function createAccessDecision(options) {
    const decision = options || {};
    const freeRemaining = Number(decision.freeRemaining);
    const planRemaining = Number(decision.planRemaining);

    return {
        allowed: decision.allowed === true,
        grant_type: cleanText(decision.grantType),
        status: cleanText(decision.status),
        message: cleanText(decision.message),
        remaining_downloads: Number.isFinite(planRemaining) ? planRemaining : 0,
        free_download_remaining: Number.isFinite(freeRemaining) ? freeRemaining : -1,
        monthly_download_remaining: Number.isFinite(planRemaining) ? planRemaining : 0,
        weekly_premium_remaining: Number.isFinite(planRemaining) ? planRemaining : 0,
        can_buy: decision.canBuy === true,
        can_upgrade: decision.canUpgrade === true
    };
}

module.exports = {
    buildDesignAccessDecision,
    getDesignAccessSummary
};
