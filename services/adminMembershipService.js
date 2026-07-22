const { config, cleanText } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");

async function listAdminUsers(limit) {
    const supabase = getSupabaseAdminClient();
    const maxItems = Math.min(250, Math.max(1, Number(limit || 100)));
    const [authUsers, profiles] = await Promise.all([
        listAuthUsers(supabase, maxItems),
        listProfiles(supabase, maxItems)
    ]);

    const profileMap = new Map();
    profiles.forEach(function (profile) {
        const profileId = cleanText(profile && profile.id);
        const profileEmail = cleanText(profile && profile.email).toLowerCase();
        if (profileId) {
            profileMap.set(profileId, profile);
        }
        if (profileEmail) {
            profileMap.set(profileEmail, profile);
        }
    });

    const mergedUsers = authUsers.map(function (authUser) {
        const authId = cleanText(authUser && authUser.id);
        const authEmail = cleanText(authUser && authUser.email).toLowerCase();
        const profile = profileMap.get(authId) || profileMap.get(authEmail) || null;

        return normalizeAdminUserRecord({
            ...(profile || {}),
            id: authId || cleanText(profile && profile.id),
            email: authEmail || cleanText(profile && profile.email),
            name: cleanText(profile && profile.name) || buildDisplayName(authUser),
            role: cleanText(profile && profile.role) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.role) || "user",
            status: cleanText(profile && profile.status) || "Active",
            created_at: cleanText(profile && profile.created_at) || cleanText(authUser && authUser.created_at) || new Date().toISOString(),
            avatar_url: cleanText(profile && profile.avatar_url) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.avatar_url),
            is_premium: profile ? profile.is_premium : Boolean(authUser && authUser.user_metadata && authUser.user_metadata.is_premium),
            premium_active: profile ? profile.premium_active : Boolean(authUser && authUser.user_metadata && authUser.user_metadata.premium_active),
            premium_expiry: cleanText(profile && profile.premium_expiry) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.premium_expiry),
            plan_id: cleanText(profile && profile.plan_id) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.plan_id),
            plan_name: cleanText(profile && profile.plan_name) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.plan_name),
            active_plan_id: cleanText(profile && profile.active_plan_id) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.active_plan_id),
            active_plan_name: cleanText(profile && profile.active_plan_name) || cleanText(authUser && authUser.user_metadata && authUser.user_metadata.active_plan_name),
            free_download_count: Number(profile && profile.free_download_count || 0),
            free_download_remaining: Number(profile && profile.free_download_remaining || 0),
            weekly_premium_download_count: Number(profile && profile.weekly_premium_download_count || 0),
            weekly_premium_remaining: Number(profile && profile.weekly_premium_remaining || 0),
            weekly_reset_date: cleanText(profile && profile.weekly_reset_date)
        });
    });

    const seenKeys = new Set(
        mergedUsers.flatMap(function (item) {
            return [cleanText(item && item.id), cleanText(item && item.email).toLowerCase()].filter(Boolean);
        })
    );

    profiles.forEach(function (profile) {
        const profileId = cleanText(profile && profile.id);
        const profileEmail = cleanText(profile && profile.email).toLowerCase();
        const cacheKey = profileId || profileEmail;

        if (!cacheKey || seenKeys.has(cacheKey)) {
            return;
        }

        mergedUsers.push(normalizeAdminUserRecord({
            ...profile,
            id: profileId,
            email: profileEmail,
            name: cleanText(profile && profile.name) || buildDisplayName({ email: profileEmail, user_metadata: {} }),
            created_at: cleanText(profile && profile.created_at) || new Date().toISOString()
        }));
    });

    return mergedUsers;
}

async function listPremiumPlans() {
    return Object.entries(config.premiumPlans).map(function ([planId, plan]) {
        return normalizePremiumPlanRecord(planId, plan);
    });
}

async function grantPremiumMembership(userId, planId) {
    const supabase = getSupabaseAdminClient();
    const profile = await findProfileById(supabase, userId);

    if (!profile) {
        throw createHttpError(404, "User profile not found.");
    }

    const plan = resolvePremiumPlan(planId);
    const nowIso = new Date().toISOString();
    const nextExpiry = new Date(Date.now() + Math.max(1, Number(plan.duration_days || 0)) * 24 * 60 * 60 * 1000).toISOString();
    const updatePayload = {
        is_premium: true,
        premium_expiry: nextExpiry,
        free_download_count: Number(profile.free_download_count || 0),
        weekly_premium_download_count: 0,
        weekly_reset_date: nowIso,
        is_banned: false,
        status: "Active",
        active_plan_id: plan.plan_id,
        active_plan_name: plan.name,
        plan_id: plan.plan_id,
        plan_name: plan.name
    };

    const updated = await updateProfileWithFallback(supabase, cleanText(profile.id), updatePayload);
    return normalizeAdminUserRecord(updated.data || { ...profile, ...updatePayload });
}

async function revokePremiumMembership(userId) {
    const supabase = getSupabaseAdminClient();
    const profile = await findProfileById(supabase, userId);

    if (!profile) {
        throw createHttpError(404, "User profile not found.");
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
        is_premium: false,
        premium_expiry: null,
        weekly_premium_download_count: 0,
        weekly_reset_date: nowIso,
        active_plan_id: null,
        active_plan_name: null,
        plan_id: null,
        plan_name: "Free"
    };

    const updated = await updateProfileWithFallback(supabase, cleanText(profile.id), updatePayload);
    return normalizeAdminUserRecord(updated.data || { ...profile, ...updatePayload });
}

async function setUserBanState(userId, isBanned) {
    const supabase = getSupabaseAdminClient();
    const profile = await findProfileById(supabase, userId);

    if (!profile) {
        throw createHttpError(404, "User profile not found.");
    }

    const nextBanned = isBanned === true;
    const nowIso = new Date().toISOString();
    const updatePayload = {
        is_banned: nextBanned,
        status: nextBanned ? "Blocked" : "Active"
    };

    if (nextBanned) {
        updatePayload.is_premium = false;
        updatePayload.premium_expiry = null;
        updatePayload.weekly_premium_download_count = 0;
        updatePayload.weekly_reset_date = nowIso;
        updatePayload.active_plan_id = null;
        updatePayload.active_plan_name = null;
        updatePayload.plan_id = null;
        updatePayload.plan_name = "Free";
    }

    const updated = await updateProfileWithFallback(supabase, cleanText(profile.id), updatePayload);
    return normalizeAdminUserRecord(updated.data || { ...profile, ...updatePayload });
}

function normalizePremiumPlanRecord(planId, plan) {
    return {
        id: cleanText(plan && plan.id) || cleanText(planId),
        plan_id: cleanText(planId),
        name: cleanText(plan && plan.name) || "Premium Plan",
        price: Number(plan && plan.amountInRupees || 0),
        duration_days: Number(plan && plan.durationDays || 0),
        monthly_download_limit: Number(plan && plan.monthlyDownloadLimit || 0),
        daily_ai_limit: Number(plan && plan.dailyAiLimit || 0),
        source_access: cleanText(plan && plan.sourceAccess),
        library_access_percent: Number(plan && plan.libraryAccessPercent || 0),
        print_layout_limit: cleanText(plan && plan.printLayoutLimit),
        tools_access: plan && plan.toolsAccess && typeof plan.toolsAccess === "object" ? plan.toolsAccess : {}
    };
}

function resolvePremiumPlan(planId) {
    const normalizedPlanId = cleanText(planId);
    const defaultPlan = normalizePremiumPlanRecord("starter_149_15d", config.premiumPlans.starter_149_15d);
    const selectedPlan = normalizedPlanId && config.premiumPlans[normalizedPlanId]
        ? normalizePremiumPlanRecord(normalizedPlanId, config.premiumPlans[normalizedPlanId])
        : defaultPlan;

    if (selectedPlan && selectedPlan.plan_id) {
        return selectedPlan;
    }

    return defaultPlan;
}

async function findProfileById(supabase, userId) {
    const normalizedId = cleanText(userId);
    if (!normalizedId) {
        return null;
    }

    const byId = await supabase.from("profiles").select("*").eq("id", normalizedId).maybeSingle();
    if (byId.error) {
        throw byId.error;
    }

    return byId.data || null;
}

async function listAuthUsers(supabase, maxItems) {
    const pageSize = Math.min(100, Math.max(1, Number(maxItems || 100)));
    const users = [];
    let page = 1;

    while (users.length < maxItems) {
        const response = await supabase.auth.admin.listUsers({
            page: page,
            perPage: pageSize
        });

        if (response.error) {
            throw response.error;
        }

        const batch = Array.isArray(response && response.data && response.data.users)
            ? response.data.users
            : [];

        users.push(...batch);

        if (batch.length < pageSize) {
            break;
        }

        page += 1;
    }

    return users.slice(0, maxItems);
}

async function listProfiles(supabase, maxItems) {
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .limit(maxItems);

    if (error) {
        throw error;
    }

    return Array.isArray(data) ? data : [];
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

function normalizeAdminUserRecord(record) {
    const item = record || {};
    const premiumExpiry = cleanText(item.premium_expiry);
    const premiumExpiryMs = premiumExpiry ? new Date(premiumExpiry).getTime() : 0;
    const isPremiumFlag = item.is_premium === true || item.premium_active === true;
    const premiumActive = Boolean(isPremiumFlag && premiumExpiryMs && premiumExpiryMs > Date.now());
    const freeDownloadCount = Number(item.free_download_count || 0) || 0;
    const weeklyPremiumDownloadCount = Number(item.weekly_premium_download_count || 0) || 0;
    const freeDownloadRemaining = config.limits.freeLifetimeDownloads < 0
        ? -1
        : Math.max(0, config.limits.freeLifetimeDownloads - freeDownloadCount);
    const weeklyPremiumRemaining = Math.max(0, config.limits.premiumWeeklyDownloads - weeklyPremiumDownloadCount);
    const status = cleanText(item.status);
    const isBanned = item.is_banned === true || ["blocked", "banned"].includes(status.toLowerCase());
    const activePlanId = cleanText(item.active_plan_id || item.plan_id);
    const activePlanName = cleanText(item.active_plan_name || item.plan_name) || (premiumActive ? config.premiumPlan.name : "Free");

    return {
        ...item,
        id: cleanText(item.id),
        email: cleanText(item.email).toLowerCase(),
        name: cleanText(item.name) || cleanText(item.email).split("@")[0] || "User",
        role: cleanText(item.role) || "user",
        status: isBanned ? "Blocked" : (status || "Active"),
        is_banned: isBanned,
        premium_active: premiumActive,
        premium_expiry: premiumExpiry,
        plan_id: activePlanId,
        plan_name: activePlanName,
        active_plan_id: activePlanId,
        active_plan_name: activePlanName,
        free_download_count: freeDownloadCount,
        free_download_remaining: freeDownloadRemaining,
        weekly_premium_download_count: weeklyPremiumDownloadCount,
        weekly_premium_remaining: weeklyPremiumRemaining,
        weekly_reset_date: cleanText(item.weekly_reset_date)
    };
}

function buildDisplayName(authUser) {
    const metadata = authUser && authUser.user_metadata ? authUser.user_metadata : {};
    return cleanText(metadata.full_name || metadata.display_name || metadata.name) || cleanText(authUser && authUser.email).split("@")[0] || "User";
}

module.exports = {
    grantPremiumMembership,
    listAdminUsers,
    listPremiumPlans,
    revokePremiumMembership,
    setUserBanState
};
