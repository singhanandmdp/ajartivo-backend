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

async function findExistingPayment(paymentId, orderId) {
    const normalizedPaymentId = cleanText(paymentId);
    const normalizedOrderId = cleanText(orderId);

    if (!normalizedPaymentId && !normalizedOrderId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    let query = supabase.from("payments").select("*").limit(1);

    if (normalizedPaymentId) {
        query = query.or(`payment_id.eq.${normalizedPaymentId},razorpay_payment_id.eq.${normalizedPaymentId}`);
    } else if (normalizedOrderId) {
        query = query.or(`order_id.eq.${normalizedOrderId},razorpay_order_id.eq.${normalizedOrderId}`);
    }

    const { data, error } = await query;
    if (error) {
        if (isMissingColumnError(error)) {
            return null;
        }

        throw error;
    }

    return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function savePaymentRecord(context) {
    const payload = buildPaymentPayload(context);
    const supabase = getSupabaseAdminClient();

    const existing = await findExistingPayment(payload.payment_id, payload.order_id);
    if (existing) {
        return existing;
    }

    const { data, error } = await supabase
        .from("payments")
        .insert(payload)
        .select("*")
        .single();

    if (error) {
        if (isMissingColumnError(error)) {
            const fallbackPayload = buildPaymentPayload(context, { omitLedgerFields: true });
            const fallbackResult = await supabase
                .from("payments")
                .insert(fallbackPayload)
                .select("*")
                .single();

            if (fallbackResult.error) {
                throw fallbackResult.error;
            }

            return fallbackResult.data;
        }

        if (isDuplicateError(error)) {
            return findExistingPayment(payload.payment_id, payload.order_id);
        }

        throw error;
    }

    return data;
}

function buildPurchasePayload(context) {
    const authUser = context && context.authUser ? context.authUser : {};
    const design = context && context.design ? context.design : {};
    const payment = context && context.payment ? context.payment : {};
    const orderId = cleanText(context && context.orderId || payment.order_id);

    const rawAmountInPaise = Number(payment.amount || design.amount_in_paise || 0);
    const payload = {
        user_id: cleanText(authUser.id),
        design_id: cleanText(design.id),
        payment_id: cleanText(payment.id),
        order_id: orderId,
        amount: Number.isFinite(rawAmountInPaise) ? rawAmountInPaise / 100 : 0,
        created_at: new Date().toISOString()
    };

    if (!payload.user_id || !payload.design_id || !payload.payment_id) {
        throw createHttpError(400, "Purchase record is missing required fields.");
    }

    return payload;
}

function buildPaymentPayload(context, options) {
    const settings = options || {};
    const authUser = context && context.authUser ? context.authUser : {};
    const design = context && context.design ? context.design : {};
    const payment = context && context.payment ? context.payment : {};
    const orderId = cleanText(context && context.orderId || payment.order_id);
    const paymentId = cleanText(payment.id);
    const amountInRupees = Number(payment.amount || design.amount_in_paise || 0);
    const quantity = Math.max(1, Number(context && context.quantity || 1));
    const status = cleanText(payment.status).toLowerCase() === "captured" ? "Paid" : "Paid";

    const record = {
        payer: cleanText(authUser.email) || cleanText(authUser.name) || cleanText(payment.email) || "AJartivo Customer",
        design_id: cleanText(design.id),
        design_name: cleanText(design.title) || "AJartivo Design",
        quantity: quantity,
        amount: Number.isFinite(amountInRupees) ? amountInRupees / 100 : 0,
        method: cleanText(payment.method) || "Razorpay",
        status: status,
        created_at: new Date().toISOString()
    };

    if (settings.omitLedgerFields !== true) {
        record.payment_id = paymentId;
        record.order_id = orderId;
    }

    return record;
}

function isDuplicateError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();
    return code === "23505" || message.includes("duplicate");
}

module.exports = {
    findExistingPurchase,
    savePaymentRecord,
    savePurchaseRecord
};
