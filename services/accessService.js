const { cleanText, config } = require("../config");
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

    const isFreeDesign = design.is_free === true;
    const isPremiumDesign = design.is_premium === true && isFreeDesign !== true;
    const premiumActive = userProfile.premium_active === true;
    const freeRemaining = Number(userProfile.free_download_remaining || 0);
    const weeklyRemaining = Number(userProfile.weekly_premium_remaining || 0);
    const canBuy = Number(design.amount_in_paise || 0) > 0;

    if (purchase) {
        return createAccessDecision({
            allowed: true,
            grantType: "purchased",
            status: "unlocked",
            message: "Purchase confirmed. This design is available in your account.",
            canBuy: false,
            canUpgrade: premiumActive !== true,
            freeRemaining: freeRemaining,
            weeklyRemaining: weeklyRemaining
        });
    }

    if (isFreeDesign) {
        return createAccessDecision({
            allowed: true,
            grantType: "free_login",
            status: premiumActive ? "premium" : "free",
            message: premiumActive
                ? "Premium Active: Free designs download instantly after login."
                : "Free design unlocked. Logged-in members can download instantly.",
            canBuy: false,
            canUpgrade: false,
            freeRemaining: freeRemaining,
            weeklyRemaining: weeklyRemaining
        });
    }

    if (premiumActive && isPremiumDesign && weeklyRemaining > 0) {
        return createAccessDecision({
            allowed: true,
            grantType: "premium_weekly",
            status: "premium",
            message: `Premium Active: Unlimited downloads. You have ${weeklyRemaining} out of ${config.limits.premiumWeeklyDownloads} premium downloads remaining this week.`,
            canBuy: canBuy,
            canUpgrade: false,
            freeRemaining: freeRemaining,
            weeklyRemaining: weeklyRemaining
        });
    }

    if (premiumActive && isPremiumDesign && weeklyRemaining <= 0) {
        return createAccessDecision({
            allowed: false,
            grantType: "none",
            status: "weekly_limit_reached",
            message: `Premium Active: Unlimited downloads. You have 0 out of ${config.limits.premiumWeeklyDownloads} premium downloads remaining this week.`,
            canBuy: canBuy,
            canUpgrade: false,
            freeRemaining: freeRemaining,
            weeklyRemaining: weeklyRemaining
        });
    }

    if (isPremiumDesign) {
        return createAccessDecision({
            allowed: false,
            grantType: "none",
            status: "premium_design_locked",
            message: `You have ${freeRemaining} out of ${config.limits.freeLifetimeDownloads} free downloads remaining. Upgrade to Premium or buy this design to continue.`,
            canBuy: canBuy,
            canUpgrade: true,
            freeRemaining: freeRemaining,
            weeklyRemaining: weeklyRemaining
        });
    }

    return createAccessDecision({
        allowed: false,
        grantType: "none",
        status: "purchase_required",
        message: "This design requires an individual purchase before download.",
        canBuy: canBuy,
        canUpgrade: premiumActive !== true,
        freeRemaining: freeRemaining,
        weeklyRemaining: weeklyRemaining
    });
}

function createAccessDecision(options) {
    const decision = options || {};

    return {
        allowed: decision.allowed === true,
        grant_type: cleanText(decision.grantType),
        status: cleanText(decision.status),
        message: cleanText(decision.message),
        free_download_remaining: Number(decision.freeRemaining || 0),
        weekly_premium_remaining: Number(decision.weeklyRemaining || 0),
        can_buy: decision.canBuy === true,
        can_upgrade: decision.canUpgrade === true
    };
}

module.exports = {
    buildDesignAccessDecision,
    getDesignAccessSummary
};
