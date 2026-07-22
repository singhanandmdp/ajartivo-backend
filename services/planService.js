const { cleanText, config } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");

async function listPlans() {
    const defaults = getDefaultPlans();

    try {
        const supabase = getSupabaseAdminClient();
        const { data, error } = await supabase
            .from("plans_master")
            .select("*")
            .order("price", { ascending: true });

        if (error) {
            if (isMissingRelationError(error)) {
                return defaults;
            }

            throw error;
        }

        if (!Array.isArray(data) || !data.length) {
            return defaults;
        }

        return data.map(normalizePlanRecord);
    } catch (error) {
        if (isConfigurationError(error)) {
            return defaults;
        }

        throw error;
    }
}

async function getPlanById(planId) {
    const normalizedId = cleanText(planId);
    const plans = await listPlans();
    return plans.find(function (plan) {
        return cleanText(plan.plan_id) === normalizedId;
    }) || plans[plans.length - 1] || null;
}

function getDefaultPlans() {
    return Object.values(config.premiumPlans || {}).map(function (plan) {
        return normalizePlanRecord({
            plan_id: plan.id,
            name: plan.name,
            price: plan.amountInRupees,
            duration_days: plan.durationDays,
            monthly_download_limit: plan.monthlyDownloadLimit,
            daily_ai_limit: plan.dailyAiLimit,
            source_access: plan.sourceAccess,
            library_access_percent: plan.libraryAccessPercent,
            tools_access: plan.toolsAccess,
            print_layout_limit: plan.printLayoutLimit
        });
    });
}

function normalizePlanRecord(record) {
    const plan = record || {};
    const sourceAccess = cleanText(plan.source_access || plan.sourceAccess);
    const libraryAccessPercent = normalizePercent(
        plan.library_access_percent ||
        plan.libraryAccessPercent
    );
    const toolsAccess = normalizeToolsAccess(plan.tools_access, {
        source_access: sourceAccess,
        design_library_access_percent: libraryAccessPercent
    });
    const monthlyDownloadLimit = normalizeLimitValue(
        plan.monthly_download_limit ||
        plan.monthlyDownloadLimit ||
        plan.premium_download_limit ||
        plan.weekly_download_limit
    );

    return {
        plan_id: cleanText(plan.plan_id || plan.id),
        id: cleanText(plan.plan_id || plan.id),
        name: cleanText(plan.name),
        price: Number(plan.price || plan.amountInRupees || 0) || 0,
        duration_days: Number(plan.duration_days || plan.durationDays || 0) || 0,
        monthly_download_limit: monthlyDownloadLimit,
        premium_download_limit: monthlyDownloadLimit,
        weekly_download_limit: monthlyDownloadLimit,
        premium_download_window_days: 30,
        daily_ai_limit: normalizeLimitValue(plan.daily_ai_limit || plan.dailyAiLimit),
        source_access: cleanText(toolsAccess.source_access) || "none",
        library_access_percent: normalizePercent(toolsAccess.design_library_access_percent),
        tools_access: toolsAccess,
        print_layout_limit: cleanText(plan.print_layout_limit || plan.printLayoutLimit) || "limited"
    };
}

function normalizeLimitValue(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return 0;
    }

    return numericValue < 0 ? -1 : numericValue;
}

function normalizeToolsAccess(value, fallbackValues) {
    const source = value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    const fallback = fallbackValues && typeof fallbackValues === "object"
        ? fallbackValues
        : {};

    return {
        source_access: cleanText(source.source_access || fallback.source_access) || "none",
        design_library_access_percent: normalizePercent(
            source.design_library_access_percent || fallback.design_library_access_percent
        ),
        background_remover: cleanText(source.background_remover) || "basic",
        image_enhancer: cleanText(source.image_enhancer) || "basic",
        ai_output_quality: cleanText(source.ai_output_quality) || "standard",
        image_resizer: cleanText(source.image_resizer) || "limited",
        image_converter: cleanText(source.image_converter) || "limited",
        ai_design_generator_limit: normalizeLimitValue(source.ai_design_generator_limit),
        print_layout_pro: cleanText(source.print_layout_pro) || "limited_templates",
        processing_speed: cleanText(source.processing_speed) || "normal",
        watermark: source.watermark !== true ? false : true
    };
}

function normalizePercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    if (numeric < 0) {
        return 0;
    }

    if (numeric > 100) {
        return 100;
    }

    return Math.round(numeric);
}

function isConfigurationError(error) {
    return cleanText(error && error.message).toLowerCase().includes("not configured");
}

function isMissingRelationError(error) {
    const code = cleanText(error && error.code).toUpperCase();
    const message = cleanText(error && (error.message || error.details)).toLowerCase();
    return code === "42P01" || (message.includes("relation") && message.includes("does not exist"));
}

module.exports = {
    getDefaultPlans,
    getPlanById,
    listPlans,
    normalizePlanRecord
};
