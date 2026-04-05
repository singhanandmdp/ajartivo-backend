const { cleanText } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");

async function findExistingPurchase(authUser, designId) {
    const userId = cleanText(authUser && authUser.id);
    const normalizedDesignId = cleanText(designId);

    if (!userId || !normalizedDesignId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("purchases")
        .select("*")
        .eq("user_id", userId)
        .eq("design_id", normalizedDesignId)
        .limit(1);

    if (error) {
        throw error;
    }

    return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function savePurchaseRecord(context) {
    const payload = buildPurchasePayload(context);
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
        .from("purchases")
        .insert(payload)
        .select("*")
        .single();

    if (error) {
        if (isDuplicateError(error)) {
            return findExistingPurchase(context.authUser, context.design.id);
        }

        throw error;
    }

    return data;
}

function buildPurchasePayload(context) {
    const authUser = context && context.authUser ? context.authUser : {};
    const design = context && context.design ? context.design : {};
    const payment = context && context.payment ? context.payment : {};

    const rawAmountInPaise = Number(payment.amount || design.amount_in_paise || 0);
    const payload = {
        user_id: cleanText(authUser.id),
        design_id: cleanText(design.id),
        payment_id: cleanText(payment.id),
        amount: Number.isFinite(rawAmountInPaise) ? rawAmountInPaise / 100 : 0,
        created_at: new Date().toISOString()
    };

    if (!payload.user_id || !payload.design_id || !payload.payment_id) {
        throw createHttpError(400, "Purchase record is missing required fields.");
    }

    return payload;
}

function isDuplicateError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();
    return code === "23505" || message.includes("duplicate");
}

module.exports = {
    findExistingPurchase,
    savePurchaseRecord
};
