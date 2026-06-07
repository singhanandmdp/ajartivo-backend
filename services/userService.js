const { cleanText, config } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");
const { getPlanById } = require("./planService");
const {
    createOrReplaceActiveSubscription,
    getActiveSubscription,
    listUserSubscriptions,
    revokeActiveSubscription
} = require("./subscriptionService");
const {
    consumeAiUsage,
    consumeDownloadUsage,
    createEmptyUsageSummary,
    getUserUsageSummary
} = require("./usageService");

async function ensureUserProfile(authUser) {
    const supabase = getSupabaseAdminClient();
    const userId = cleanText(authUser && authUser.id);
    const email = cleanText(authUser && authUser.email).toLowerCase();
    const authProfile = buildAuthProfileDetails(authUser);

    if (!userId) {
        throw createHttpError(401, "Authenticated user ID is required.");
    }

    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    let profile = data;

    if (!profile) {
        const insertPayload = {
            id: userId,
            email: email,
            first_name: authProfile.first_name,
            last_name: authProfile.last_name,
            address: authProfile.address,
            mobile_number: authProfile.mobile_number,
            role: "user",
            is_banned: false,
            is_premium: false,
            current_plan_id: null,
            premium_expiry: null,
            free_download_count: 0,
            weekly_premium_download_count: 0,
            weekly_reset_date: new Date().toISOString()
        };

        const insertResult = await insertProfileWithFallback(supabase, insertPayload);
        if (insertResult.error) {
            throw insertResult.error;
        }

        profile = insertResult.data;
    }

    if (profile && profile.is_banned === true) {
        throw createHttpError(403, "This account has been restricted by AJartivo.");
    }

    const activeSubscription = await getActiveSubscription(userId);
    const activePlan = activeSubscription ? await getPlanById(activeSubscription.plan_id) : null;
    const usage = await getUserUsageSummary(userId).catch(function () {
        return createEmptyUsageSummary();
    });

    profile = await synchronizeProfileState(profile, authUser, activeSubscription, activePlan);
    return normalizeUserProfile(profile, {
        activeSubscription: activeSubscription,
        activePlan: activePlan,
        usage: usage
    });
}

async function activatePremiumMembership(authUser, plan, context) {
    const profile = await ensureUserProfile(authUser);
    const selectedPlan = await resolvePlanInput(plan);
    const metadata = context && context.metadata ? context.metadata : {};

    const subscription = await createOrReplaceActiveSubscription({
        userId: profile.id,
        plan: selectedPlan,
        paymentId: cleanText(context && context.paymentId),
        orderId: cleanText(context && context.orderId),
        grantedBy: cleanText(context && context.grantedBy),
        durationDays: Number(selectedPlan.duration_days || selectedPlan.durationDays || 0),
        metadata: metadata
    });

    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(supabase, profile.id, {
        email: cleanText(authUser && authUser.email).toLowerCase(),
        is_premium: true,
        current_plan_id: selectedPlan.plan_id,
        premium_expiry: subscription.expires_at,
        weekly_premium_download_count: 0,
        weekly_reset_date: new Date().toISOString()
    });

    if (error) {
        throw error;
    }

    return normalizeUserProfile(data || profile, {
        activeSubscription: subscription,
        activePlan: selectedPlan,
        usage: await getUserUsageSummary(profile.id).catch(function () {
            return createEmptyUsageSummary();
        })
    });
}

async function revokePremiumMembership(userId) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        throw createHttpError(400, "User ID is required.");
    }

    const revoked = await revokeActiveSubscription(normalizedUserId);
    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(supabase, normalizedUserId, {
        is_premium: false,
        current_plan_id: null,
        premium_expiry: null
    });

    if (error) {
        throw error;
    }

    return {
        profile: normalizeUserProfile(data || { id: normalizedUserId }),
        subscription: revoked
    };
}

async function consumeUserEntitlement(userProfile, accessGrant) {
    const profile = normalizeUserProfile(userProfile);
    await consumeProfileDownloadEntitlement(profile, accessGrant);
    if (cleanText(accessGrant) === "premium_plan") {
        await consumeDownloadUsage(profile.id).catch(function () {
            return null;
        });
    }

    return ensureUserProfile({
        id: profile.id,
        email: profile.email,
        user_metadata: {
            full_name: profile.name,
            first_name: profile.first_name,
            last_name: profile.last_name
        }
    });
}

async function consumeToolEntitlement(authUser, toolId) {
    const profile = await ensureUserProfile(authUser);
    const toolKey = cleanText(toolId).toLowerCase();
    const toolAccess = profile.tools_access || {};
    const dailyLimit = Number(profile.daily_ai_limit);
    const usedToday = Number(profile.ai_generations_used_today || 0);

    if (profile.is_banned === true) {
        throw createHttpError(403, "This account has been restricted by AJartivo.");
    }

    if (!isToolEnabled(toolKey, toolAccess, profile.premium_active)) {
        throw createHttpError(403, "This tool is not available for your current plan.");
    }

    if (dailyLimit >= 0 && usedToday >= dailyLimit) {
        throw createHttpError(403, "Daily designer tool limit reached for your current plan.");
    }

    await consumeAiUsage(profile.id, 1);
    return ensureUserProfile({
        id: profile.id,
        email: profile.email,
        user_metadata: {
            full_name: profile.name,
            first_name: profile.first_name,
            last_name: profile.last_name
        }
    });
}

async function updateUserAvatar(authUser, avatarUrl) {
    const profile = await ensureUserProfile(authUser);
    const normalizedAvatarUrl = cleanText(avatarUrl);

    if (!normalizedAvatarUrl) {
        throw createHttpError(400, "Avatar URL is required.");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(supabase, profile.id, {
        email: cleanText(authUser && authUser.email).toLowerCase(),
        avatar_url: normalizedAvatarUrl
    });

    if (error) {
        throw error;
    }

    return normalizeUserProfile(data || {
        ...profile,
        avatar_url: normalizedAvatarUrl
    }, {
        activePlan: profile.active_plan,
        activeSubscription: profile.active_subscription,
        usage: {
            downloads_used_month: Number(profile.downloads_used_month || 0),
            ai_generations_used_today: Number(profile.ai_generations_used_today || 0)
        }
    });
}

async function setUserBanState(userId, isBanned) {
    const normalizedUserId = cleanText(userId);
    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(supabase, normalizedUserId, {
        is_banned: isBanned === true
    });

    if (error) {
        throw error;
    }

    if (isBanned === true) {
        await revokeActiveSubscription(normalizedUserId).catch(function () {
            return null;
        });
    }

    return normalizeUserProfile(data || {
        id: normalizedUserId,
        is_banned: isBanned === true
    });
}

async function listUsersForAdmin(limit) {
    const supabase = getSupabaseAdminClient();
    const maxItems = Math.min(100, Math.max(1, Number(limit || 50)));
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(maxItems);

    if (error) {
        throw error;
    }

    const profiles = Array.isArray(data) ? data : [];
    return Promise.all(profiles.map(async function (profile) {
        const activeSubscription = await getActiveSubscription(profile.id).catch(function () {
            return null;
        });
        const activePlan = activeSubscription
            ? await getPlanById(activeSubscription.plan_id).catch(function () {
                return null;
            })
            : null;
        const usage = await getUserUsageSummary(profile.id).catch(function () {
            return createEmptyUsageSummary();
        });

        return normalizeUserProfile(profile, {
            activeSubscription: activeSubscription,
            activePlan: activePlan,
            usage: usage
        });
    }));
}

async function getUserAdminSummary(userId) {
    const normalizedUserId = cleanText(userId);
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", normalizedUserId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) {
        return null;
    }

    const activeSubscription = await getActiveSubscription(normalizedUserId).catch(function () {
        return null;
    });
    const activePlan = activeSubscription
        ? await getPlanById(activeSubscription.plan_id).catch(function () {
            return null;
        })
        : null;
    const usage = await getUserUsageSummary(normalizedUserId).catch(function () {
        return createEmptyUsageSummary();
    });
    const subscriptions = await listUserSubscriptions(normalizedUserId).catch(function () {
        return [];
    });

    return {
        profile: normalizeUserProfile(data, {
            activeSubscription: activeSubscription,
            activePlan: activePlan,
            usage: usage
        }),
        subscriptions: subscriptions
    };
}

function normalizeUserProfile(profile, context) {
    const record = profile || {};
    const options = context || {};
    const activeSubscription = options.activeSubscription || null;
    const activePlan = options.activePlan || null;
    const usage = options.usage || createEmptyUsageSummary();
    const legacyPremiumExpiry = cleanText(record.premium_expiry);
    const derivedPremiumExpiry = cleanText(activeSubscription && activeSubscription.expires_at) || legacyPremiumExpiry;
    const premiumExpiryMs = derivedPremiumExpiry ? new Date(derivedPremiumExpiry).getTime() : 0;
    const premiumActive = Boolean(
        activeSubscription && activePlan
            ? premiumExpiryMs > Date.now()
            : record.is_premium === true && premiumExpiryMs > Date.now()
    );
    const freeDownloadLimit = resolveFreeDownloadLimit();
    const normalizedFreeCount = Math.max(0, Number(record.free_download_count || 0) || 0);
    const premiumDownloadLimit = premiumActive && activePlan
        ? resolvePremiumDownloadLimit(activePlan)
        : 0;
    const premiumDownloadsUsedCycle = premiumActive
        ? Math.max(0, Number(usage.downloads_used_month || 0) || 0)
        : 0;
    const premiumDownloadsRemaining = premiumDownloadLimit < 0
        ? -1
        : Math.max(0, premiumDownloadLimit - premiumDownloadsUsedCycle);
    const dailyAiLimit = premiumActive && activePlan
        ? Number(activePlan.daily_ai_limit)
        : config.limits.freeToolDailyLimit;
    const aiUsedToday = Number(usage.ai_generations_used_today || 0) || 0;
    const downloadsRemainingMonth = premiumActive
        ? premiumDownloadsRemaining
        : freeDownloadLimit < 0
        ? -1
        : Math.max(0, freeDownloadLimit - normalizedFreeCount);
    const aiRemainingToday = dailyAiLimit < 0
        ? -1
        : Math.max(0, dailyAiLimit - aiUsedToday);
    const freeToolAccess = {
        source_access: "none",
        design_library_access_percent: 5,
        background_remover: "starter",
        image_enhancer: "starter",
        image_resizer: "starter",
        image_converter: "starter",
        print_layout_pro: "starter",
        processing_speed: "normal",
        watermark: true
    };
    const toolsAccess = premiumActive && activePlan
        ? activePlan.tools_access
        : freeToolAccess;
    const planId = premiumActive && activePlan ? cleanText(activePlan.plan_id) : "";
    const planName = premiumActive && activePlan ? cleanText(activePlan.name) : "Free";
    const premiumCycleMarker = resolvePremiumCycleMarker(usage);

    return {
        ...record,
        id: cleanText(record.id),
        email: cleanText(record.email).toLowerCase(),
        first_name: cleanText(record.first_name),
        last_name: cleanText(record.last_name),
        address: cleanText(record.address),
        mobile_number: cleanText(record.mobile_number),
        avatar_url: cleanText(record.avatar_url),
        role: cleanText(record.role).toLowerCase() || "user",
        is_banned: record.is_banned === true,
        is_premium: premiumActive,
        premium_active: premiumActive,
        current_plan_id: planId,
        premium_expiry: derivedPremiumExpiry,
        free_download_limit: freeDownloadLimit,
        free_download_count: normalizedFreeCount,
        weekly_premium_download_limit: premiumDownloadLimit,
        weekly_premium_download_count: premiumDownloadsUsedCycle,
        weekly_reset_date: premiumCycleMarker,
        free_download_remaining: freeDownloadLimit < 0
            ? -1
            : Math.max(0, freeDownloadLimit - normalizedFreeCount),
        weekly_premium_remaining: premiumDownloadsRemaining,
        premium_badge: premiumActive ? `${planName} Active` : "Free Member",
        active_plan: activePlan,
        active_plan_id: planId,
        active_plan_name: planName,
        active_subscription: activeSubscription,
        monthly_download_limit: premiumDownloadLimit,
        downloads_used_month: premiumDownloadsUsedCycle,
        downloads_remaining_month: downloadsRemainingMonth,
        daily_ai_limit: dailyAiLimit,
        ai_generations_used_today: aiUsedToday,
        ai_remaining_today: aiRemainingToday,
        print_layout_limit: premiumActive && activePlan
            ? cleanText(activePlan.print_layout_limit)
            : "starter",
        source_access: cleanText(toolsAccess && toolsAccess.source_access) || "none",
        library_access_percent: Number(toolsAccess && toolsAccess.design_library_access_percent || 0) || 0,
        tools_access: toolsAccess,
        name: [cleanText(record.first_name), cleanText(record.last_name)].filter(Boolean).join(" ") || cleanText(record.email).split("@")[0] || "Creative Member"
    };
}

function buildAuthProfileDetails(authUser) {
    const metadata = authUser && authUser.user_metadata ? authUser.user_metadata : {};
    const fullName = cleanText(metadata.full_name || metadata.name);
    const [firstName = "", ...rest] = fullName.split(/\s+/).filter(Boolean);

    return {
        first_name: cleanText(metadata.first_name) || firstName,
        last_name: cleanText(metadata.last_name) || rest.join(" "),
        address: cleanText(metadata.address),
        mobile_number: cleanText(metadata.mobile_number || metadata.phone_number || metadata.phone)
    };
}

async function synchronizeProfileState(profile, authUser, activeSubscription, activePlan) {
    const normalized = normalizeUserProfile(profile, {
        activeSubscription: activeSubscription,
        activePlan: activePlan,
        usage: await getUserUsageSummary(cleanText(profile && profile.id)).catch(function () {
            return createEmptyUsageSummary();
        })
    });
    const updatePayload = {};
    const authEmail = cleanText(authUser && authUser.email).toLowerCase();
    const authProfile = buildAuthProfileDetails(authUser);

    if (authEmail && authEmail !== cleanText(profile && profile.email).toLowerCase()) {
        updatePayload.email = authEmail;
    }

    if (!normalized.first_name && authProfile.first_name) {
        updatePayload.first_name = authProfile.first_name;
    }

    if (!normalized.last_name && authProfile.last_name) {
        updatePayload.last_name = authProfile.last_name;
    }

    if (!normalized.address && authProfile.address) {
        updatePayload.address = authProfile.address;
    }

    if (!normalized.mobile_number && authProfile.mobile_number) {
        updatePayload.mobile_number = authProfile.mobile_number;
    }

    if (cleanText(profile && profile.current_plan_id) !== normalized.active_plan_id) {
        updatePayload.current_plan_id = normalized.active_plan_id || null;
    }

    if (profile && profile.is_premium !== normalized.premium_active) {
        updatePayload.is_premium = normalized.premium_active;
    }

    if (cleanText(profile && profile.premium_expiry) !== cleanText(normalized.premium_expiry)) {
        updatePayload.premium_expiry = normalized.premium_expiry || null;
    }

    if (cleanText(profile && profile.weekly_reset_date) !== cleanText(normalized.weekly_reset_date)) {
        updatePayload.weekly_reset_date = normalized.weekly_reset_date || new Date().toISOString();
    }

    if (Number(profile && profile.weekly_premium_download_count || 0) !== Number(normalized.weekly_premium_download_count || 0)) {
        updatePayload.weekly_premium_download_count = Number(normalized.weekly_premium_download_count || 0) || 0;
    }

    if (!Object.keys(updatePayload).length) {
        return profile;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(supabase, cleanText(profile && profile.id), updatePayload);
    if (error) {
        throw error;
    }

    return data || profile;
}

async function resolvePlanInput(plan) {
    if (plan && typeof plan === "object" && cleanText(plan.plan_id || plan.id)) {
        return {
            ...plan,
            plan_id: cleanText(plan.plan_id || plan.id)
        };
    }

    const resolvedPlan = await getPlanById(plan);
    if (!resolvedPlan) {
        throw createHttpError(400, "Selected plan was not found.");
    }

    return resolvedPlan;
}

function isToolEnabled(toolId, toolsAccess, premiumActive) {
    if (!toolId) {
        return false;
    }

    if (premiumActive === true) {
        return true;
    }

    return [
        "background_remover",
        "image_enhancer",
        "image_resizer",
        "image_converter",
        "print_layout_pro"
    ].includes(toolId) && Boolean(toolsAccess);
}

async function consumeProfileDownloadEntitlement(profile, accessGrant) {
    const grantType = cleanText(accessGrant);
    const normalizedProfile = normalizeUserProfile(profile);
    const updatePayload = {};

    if (grantType === "free_design") {
        updatePayload.free_download_count = Number(normalizedProfile.free_download_count || 0) + 1;
    }

    if (!Object.keys(updatePayload).length) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const result = await updateProfileWithFallback(supabase, normalizedProfile.id, updatePayload);
    if (result.error) {
        throw result.error;
    }

    return result.data || null;
}

function resolveFreeDownloadLimit() {
    const configuredLimit = Number(config.limits && config.limits.freeLifetimeDownloads);
    if (!Number.isFinite(configuredLimit)) {
        return -1;
    }

    return configuredLimit < 0 ? -1 : Math.max(0, configuredLimit);
}

function resolvePremiumDownloadLimit(plan) {
    const record = plan || {};
    const configuredPlanLimit = Number(
        record.monthly_download_limit ||
        record.monthlyDownloadLimit ||
        record.premium_download_limit ||
        record.weekly_download_limit
    );

    if (Number.isFinite(configuredPlanLimit)) {
        return configuredPlanLimit < 0 ? -1 : Math.max(0, configuredPlanLimit);
    }

    return 0;
}

function resolvePremiumCycleMarker(usage) {
    const monthKey = cleanText(usage && usage.month_key);
    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
        return new Date().toISOString();
    }

    return `${monthKey}-01T00:00:00.000Z`;
}

async function insertProfileWithFallback(supabase, payload) {
    return mutateProfileWithFallback(function (nextPayload) {
        return supabase
            .from("profiles")
            .insert(nextPayload)
            .select("*")
            .single();
    }, payload);
}

async function updateProfileWithFallback(supabase, profileId, payload) {
    return mutateProfileWithFallback(function (nextPayload) {
        return supabase
            .from("profiles")
            .update(nextPayload)
            .eq("id", profileId)
            .select("*")
            .single();
    }, payload);
}

async function mutateProfileWithFallback(executor, payload) {
    let nextPayload = { ...(payload || {}) };
    let lastResult = null;

    while (Object.keys(nextPayload).length) {
        const result = await executor(nextPayload);
        if (!result.error) {
            return result;
        }

        const missingColumn = readMissingColumnName(result.error);
        if (!missingColumn || !Object.prototype.hasOwnProperty.call(nextPayload, missingColumn)) {
            return result;
        }

        delete nextPayload[missingColumn];
        lastResult = result;
    }

    return lastResult || { data: null, error: null };
}

function readMissingColumnName(error) {
    const message = cleanText(error && (error.message || error.details || error.hint));
    const schemaCacheMatch = message.match(/could not find the ['"]([^'"]+)['"] column/i);
    if (schemaCacheMatch && schemaCacheMatch[1]) {
        return cleanText(schemaCacheMatch[1]);
    }

    const missingColumnMatch = message.match(/column ['"]?([^'".\s]+)['"]? does not exist/i);
    if (missingColumnMatch && missingColumnMatch[1]) {
        return cleanText(missingColumnMatch[1]);
    }

    return "";
}

module.exports = {
    activatePremiumMembership,
    consumeToolEntitlement,
    consumeUserEntitlement,
    ensureUserProfile,
    getUserAdminSummary,
    listUsersForAdmin,
    normalizeUserProfile,
    revokePremiumMembership,
    setUserBanState,
    updateUserAvatar
};
