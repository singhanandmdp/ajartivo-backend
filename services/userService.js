const { cleanText, config } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");

async function ensureUserProfile(authUser) {
    const supabase = getSupabaseAdminClient();
    const userId = cleanText(authUser && authUser.id);
    const email = cleanText(authUser && authUser.email).toLowerCase();
    const authProfile = buildAuthProfileDetails(authUser);

    if (!userId) {
        throw new Error("Authenticated user ID is required.");
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
            is_premium: false,
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

    profile = await synchronizeProfileState(profile, authUser);
    return normalizeUserProfile(profile);
}

async function synchronizeProfileState(profile, authUser) {
    const normalized = normalizeUserProfile(profile);
    const updatePayload = {};
    const nowIso = new Date().toISOString();
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

    if (needsWeeklyReset(normalized)) {
        updatePayload.weekly_premium_download_count = 0;
        updatePayload.weekly_reset_date = nowIso;
    }

    if (normalized.is_premium === true && normalized.premium_active !== true) {
        updatePayload.is_premium = false;
    }

    if (!Object.keys(updatePayload).length) {
        return profile;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await updateProfileWithFallback(
        supabase,
        cleanText(profile && profile.id),
        updatePayload
    );

    if (error) {
        throw error;
    }

    return data || profile;
}

async function consumeUserEntitlement(userProfile, accessGrant) {
    const profile = normalizeUserProfile(userProfile);
    const supabase = getSupabaseAdminClient();
    const updatePayload = {};

    if (accessGrant === "free_lifetime") {
        updatePayload.free_download_count = Number(profile.free_download_count || 0) + 1;
    }

    if (accessGrant === "premium_weekly") {
        updatePayload.weekly_premium_download_count = Number(profile.weekly_premium_download_count || 0) + 1;
        updatePayload.weekly_reset_date = cleanText(profile.weekly_reset_date) || new Date().toISOString();
    }

    if (!Object.keys(updatePayload).length) {
        return profile;
    }

    const { data, error } = await updateProfileWithFallback(supabase, profile.id, updatePayload);

    if (error) {
        throw error;
    }

    return normalizeUserProfile(data || profile);
}

async function activatePremiumMembership(authUser) {
    const profile = await ensureUserProfile(authUser);
    const supabase = getSupabaseAdminClient();
    const nextExpiry = new Date(Date.now() + config.limits.premiumDurationDays * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await updateProfileWithFallback(supabase, profile.id, {
        email: cleanText(authUser && authUser.email).toLowerCase(),
        is_premium: true,
        premium_expiry: nextExpiry,
        weekly_premium_download_count: 0,
        weekly_reset_date: new Date().toISOString()
    });

    if (error) {
        throw error;
    }

    return normalizeUserProfile(data || {
        ...profile,
        email: cleanText(authUser && authUser.email).toLowerCase() || profile.email,
        is_premium: true,
        premium_expiry: nextExpiry
    });
}

function normalizeUserProfile(profile) {
    const record = profile || {};
    const premiumExpiry = cleanText(record.premium_expiry);
    const premiumExpiryMs = premiumExpiry ? new Date(premiumExpiry).getTime() : 0;
    const premiumActive = Boolean(record.is_premium === true && premiumExpiryMs && premiumExpiryMs > Date.now());
    const freeDownloadCount = Number(record.free_download_count || 0) || 0;
    const weeklyPremiumDownloadCount = Number(record.weekly_premium_download_count || 0) || 0;
    const freeDownloadRemaining = Math.max(0, config.limits.freeLifetimeDownloads - freeDownloadCount);
    const weeklyPremiumRemaining = Math.max(0, config.limits.premiumWeeklyDownloads - weeklyPremiumDownloadCount);

    return {
        ...record,
        id: cleanText(record.id),
        email: cleanText(record.email).toLowerCase(),
        first_name: cleanText(record.first_name),
        last_name: cleanText(record.last_name),
        address: cleanText(record.address),
        mobile_number: cleanText(record.mobile_number),
        is_premium: record.is_premium === true,
        premium_expiry: premiumExpiry,
        premium_active: premiumActive,
        free_download_count: freeDownloadCount,
        weekly_premium_download_count: weeklyPremiumDownloadCount,
        weekly_reset_date: cleanText(record.weekly_reset_date),
        free_download_remaining: freeDownloadRemaining,
        weekly_premium_remaining: weeklyPremiumRemaining,
        premium_badge: premiumActive ? "Premium Active" : "Free Member"
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

function needsWeeklyReset(profile) {
    const weeklyResetDate = cleanText(profile && profile.weekly_reset_date);
    if (!weeklyResetDate) {
        return true;
    }

    const lastResetMs = new Date(weeklyResetDate).getTime();
    if (!Number.isFinite(lastResetMs) || lastResetMs <= 0) {
        return true;
    }

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - lastResetMs >= sevenDaysMs;
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
    consumeUserEntitlement,
    ensureUserProfile,
    normalizeUserProfile
};
