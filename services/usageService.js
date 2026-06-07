const { cleanText } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");

async function getUserUsageSummary(userId, dateValue) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        return createEmptyUsageSummary(dateValue);
    }

    const now = resolveDate(dateValue);
    const monthKey = getMonthKey(now);
    const dayKey = getDayKey(now);
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
        .from("user_usage")
        .select("*")
        .eq("user_id", normalizedUserId)
        .eq("month_key", monthKey);

    if (error) {
        if (isMissingRelationError(error)) {
            return createEmptyUsageSummary(now);
        }

        throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    const downloadsUsedMonth = rows.reduce(function (total, row) {
        return total + (Number(row && row.downloads_used || 0) || 0);
    }, 0);
    const todayRow = rows.find(function (row) {
        return cleanText(row && row.day_key) === dayKey;
    });
    const aiUsedToday = Number(todayRow && todayRow.ai_generations_used || 0) || 0;

    return {
        month_key: monthKey,
        day_key: dayKey,
        downloads_used_month: downloadsUsedMonth,
        ai_generations_used_today: aiUsedToday
    };
}

async function consumeDownloadUsage(userId) {
    return mutateUsageRow(userId, function (record) {
        return {
            ...record,
            downloads_used: Number(record.downloads_used || 0) + 1
        };
    });
}

async function consumeAiUsage(userId, incrementBy) {
    const step = Math.max(1, Number(incrementBy) || 1);

    return mutateUsageRow(userId, function (record) {
        return {
            ...record,
            ai_generations_used: Number(record.ai_generations_used || 0) + step
        };
    });
}

async function mutateUsageRow(userId, updater) {
    const normalizedUserId = cleanText(userId);
    if (!normalizedUserId) {
        throw new Error("User ID is required for usage tracking.");
    }

    const now = new Date();
    const monthKey = getMonthKey(now);
    const dayKey = getDayKey(now);
    const supabase = getSupabaseAdminClient();

    const existingResult = await supabase
        .from("user_usage")
        .select("*")
        .eq("user_id", normalizedUserId)
        .eq("month_key", monthKey)
        .eq("day_key", dayKey)
        .maybeSingle();

    if (existingResult.error && !isMissingRelationError(existingResult.error)) {
        throw existingResult.error;
    }

    const existingRecord = existingResult.data || {
        user_id: normalizedUserId,
        month_key: monthKey,
        day_key: dayKey,
        downloads_used: 0,
        ai_generations_used: 0
    };
    const nextRecord = updater(existingRecord);

    const { data, error } = await supabase
        .from("user_usage")
        .upsert({
            user_id: normalizedUserId,
            month_key: monthKey,
            day_key: dayKey,
            downloads_used: Number(nextRecord.downloads_used || 0) || 0,
            ai_generations_used: Number(nextRecord.ai_generations_used || 0) || 0
        }, {
            onConflict: "user_id,month_key,day_key"
        })
        .select("*")
        .single();

    if (error) {
        if (isMissingRelationError(error)) {
            return existingRecord;
        }

        throw error;
    }

    return data;
}

function createEmptyUsageSummary(dateValue) {
    const now = resolveDate(dateValue);
    return {
        month_key: getMonthKey(now),
        day_key: getDayKey(now),
        downloads_used_month: 0,
        ai_generations_used_today: 0
    };
}

function resolveDate(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function getMonthKey(dateValue) {
    const date = resolveDate(dateValue);
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${date.getUTCFullYear()}-${month}`;
}

function getDayKey(dateValue) {
    return resolveDate(dateValue).toISOString().slice(0, 10);
}

function isMissingRelationError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();
    return code === "42P01" || (message.includes("relation") && message.includes("does not exist"));
}

module.exports = {
    consumeAiUsage,
    consumeDownloadUsage,
    createEmptyUsageSummary,
    getDayKey,
    getMonthKey,
    getUserUsageSummary
};
