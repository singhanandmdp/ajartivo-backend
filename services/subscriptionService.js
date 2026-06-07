const { cleanText } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");

async function getActiveSubscription(userId) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("user_subscriptions")
        .select("*")
        .eq("user_id", normalizedUserId)
        .in("status", ["active", "expired"])
        .order("expires_at", { ascending: false })
        .limit(10);

    if (error) {
        if (isMissingRelationError(error)) {
            return null;
        }

        throw error;
    }

    const subscriptions = Array.isArray(data) ? data : [];
    const currentActive = subscriptions.find(function (item) {
        const normalized = normalizeSubscription(item);
        return normalized.status === "active" && normalized.expires_at_ms > Date.now();
    });

    if (currentActive) {
        return normalizeSubscription(currentActive);
    }

    const expiredActive = subscriptions.find(function (item) {
        const normalized = normalizeSubscription(item);
        return normalized.status === "active" && normalized.expires_at_ms <= Date.now();
    });

    if (expiredActive) {
        await updateSubscriptionStatus(cleanText(expiredActive.id), "expired");
    }

    return null;
}

async function listUserSubscriptions(userId) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        return [];
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("user_subscriptions")
        .select("*")
        .eq("user_id", normalizedUserId)
        .order("created_at", { ascending: false });

    if (error) {
        if (isMissingRelationError(error)) {
            return [];
        }

        throw error;
    }

    return (Array.isArray(data) ? data : []).map(normalizeSubscription);
}

async function createOrReplaceActiveSubscription(options) {
    const context = options || {};
    const userId = cleanText(context.userId);
    const plan = context.plan || {};
    const planId = cleanText(plan.plan_id || plan.id);

    if (!userId || !planId) {
        throw createHttpError(400, "User ID and plan ID are required for subscription activation.");
    }

    const supabase = getSupabaseAdminClient();
    await expireActiveSubscriptions(userId, context.replacedStatus || "expired");

    const durationDays = Number(context.durationDays || plan.duration_days || 0);
    const startedAt = cleanText(context.startedAt) || new Date().toISOString();
    const expiresAt = cleanText(context.expiresAt) || new Date(
        new Date(startedAt).getTime() + Math.max(1, durationDays) * 24 * 60 * 60 * 1000
    ).toISOString();

    const payload = {
        user_id: userId,
        plan_id: planId,
        status: "active",
        started_at: startedAt,
        expires_at: expiresAt,
        payment_id: cleanText(context.paymentId),
        order_id: cleanText(context.orderId),
        granted_by: cleanText(context.grantedBy),
        metadata: context.metadata && typeof context.metadata === "object" ? context.metadata : {}
    };

    const { data, error } = await supabase
        .from("user_subscriptions")
        .insert(payload)
        .select("*")
        .single();

    if (error) {
        if (isMissingRelationError(error)) {
            return normalizeSubscription({
                id: "",
                ...payload
            });
        }

        throw error;
    }

    return normalizeSubscription(data);
}

async function expireActiveSubscriptions(userId, nextStatus) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        return;
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from("user_subscriptions")
        .update({
            status: cleanText(nextStatus) || "expired",
            updated_at: new Date().toISOString()
        })
        .eq("user_id", normalizedUserId)
        .eq("status", "active");

    if (error && !isMissingRelationError(error)) {
        throw error;
    }
}

async function revokeActiveSubscription(userId) {
    const activeSubscription = await getActiveSubscription(userId);
    if (!activeSubscription) {
        return null;
    }

    await updateSubscriptionStatus(activeSubscription.id, "revoked");
    return {
        ...activeSubscription,
        status: "revoked"
    };
}

async function updateSubscriptionStatus(subscriptionId, status) {
    const normalizedSubscriptionId = cleanText(subscriptionId);
    if (!normalizedSubscriptionId) {
        return;
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from("user_subscriptions")
        .update({
            status: cleanText(status) || "expired",
            updated_at: new Date().toISOString()
        })
        .eq("id", normalizedSubscriptionId);

    if (error && !isMissingRelationError(error)) {
        throw error;
    }
}

function normalizeSubscription(record) {
    const item = record || {};
    const expiresAt = cleanText(item.expires_at);
    const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;

    return {
        id: cleanText(item.id),
        user_id: cleanText(item.user_id),
        plan_id: cleanText(item.plan_id),
        status: cleanText(item.status) || "expired",
        started_at: cleanText(item.started_at),
        expires_at: expiresAt,
        expires_at_ms: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
        payment_id: cleanText(item.payment_id),
        order_id: cleanText(item.order_id),
        granted_by: cleanText(item.granted_by),
        metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {}
    };
}

function isMissingRelationError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();
    return code === "42P01" || (message.includes("relation") && message.includes("does not exist"));
}

module.exports = {
    createOrReplaceActiveSubscription,
    expireActiveSubscriptions,
    getActiveSubscription,
    listUserSubscriptions,
    normalizeSubscription,
    revokeActiveSubscription
};
