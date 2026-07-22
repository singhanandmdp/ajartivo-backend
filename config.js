const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");
const DOWNLOADS_ROOT = path.resolve(PROJECT_ROOT, "downloads");
const ENV_FILE_PATH = path.resolve(BACKEND_ROOT, ".env");

loadEnvFile(ENV_FILE_PATH, { overrideExisting: true });

const parsedPort = Number(process.env.PORT || 5000);

const config = {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
    backendRoot: BACKEND_ROOT,
    projectRoot: PROJECT_ROOT,
    downloadsRoot: DOWNLOADS_ROOT,
    frontendOrigins: buildFrontendOrigins(process.env.FRONTEND_ORIGINS),
    supabase: {
        url: cleanText(process.env.SUPABASE_URL),
        serviceRoleKey: cleanText(process.env.SUPABASE_SERVICE_ROLE_KEY),
        designTables: buildSupabaseDesignTables(process.env.SUPABASE_DESIGN_TABLES)
    },
    razorpay: {
        keyId: cleanText(process.env.RAZORPAY_KEY_ID),
        keySecret: cleanText(process.env.RAZORPAY_KEY_SECRET)
    },
    photoRoom: {
        apiKey: cleanText(process.env.PHOTOROOM_API_KEY),
        apiBaseUrl: cleanText(process.env.PHOTOROOM_API_BASE_URL) || "https://sdk.photoroom.com/v1/segment"
    },
    hfRemoveBg: {
        spaceId: cleanText(process.env.HF_REMOVE_BG_SPACE_ID) || "mr-singh/bg-remover",
        apiName: cleanText(process.env.HF_REMOVE_BG_API_NAME) || "/remove_bg",
        token: cleanText(process.env.HF_TOKEN),
        maxFileSizeBytes: normalizePositiveNumber(process.env.HF_REMOVE_BG_MAX_FILE_SIZE_MB, 12) * 1024 * 1024
    },
    r2: {
        accessKey: cleanText(process.env.R2_ACCESS_KEY),
        secretKey: cleanText(process.env.R2_SECRET_KEY),
        endpoint: cleanText(process.env.R2_ENDPOINT),
        publicUrl: cleanText(process.env.R2_PUBLIC_URL),
        bucketName: cleanText(
            process.env.R2_BUCKET ||
            process.env.R2_BUCKET_NAME ||
            inferBucketNameFromUrl(process.env.R2_PUBLIC_URL)
        )
    },
    uploads: {
        maxFileSizeBytes: normalizePositiveNumber(process.env.UPLOAD_MAX_FILE_SIZE_MB, 500) * 1024 * 1024,
        maxPreviewSizeBytes: normalizePositiveNumber(process.env.UPLOAD_MAX_PREVIEW_SIZE_MB, 10) * 1024 * 1024
    },
    limits: {
        freeLifetimeDownloads: -1,
        premiumWeeklyDownloads: 2,
        premiumDurationDays: 15,
        freeToolDailyLimit: 2
    },
    premiumPlan: {
        name: cleanText(process.env.PREMIUM_PLAN_NAME) || "AJartivo Starter Plan",
        amountInRupees: normalizePositiveNumber(process.env.PREMIUM_PLAN_PRICE, 149)
    },
    premiumPlans: buildPremiumPlans()
};

function buildFrontendOrigins(rawOrigins) {
    const defaults = [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "https://ajartivo.in",
        "https://admin.ajartivo.in",
        "https://www.ajartivo.in"
    ];

    const configuredOrigins = cleanText(rawOrigins)
        .split(",")
        .map(function (origin) {
            return cleanText(origin);
        })
        .filter(Boolean);

    return Array.from(new Set(defaults.concat(configuredOrigins)));
}

function buildSupabaseDesignTables(rawTables) {
    const defaults = ["designs"];
    const configuredTables = cleanText(rawTables)
        .split(",")
        .map(function (tableName) {
            return cleanTableName(tableName);
        })
        .filter(Boolean);

    // Always prefer the canonical `designs` table first so stale fallback tables
    // cannot override the current paid/free state for the same design id.
    return Array.from(new Set(defaults.concat(configuredTables))).filter(Boolean);
}

function loadEnvFile(filePath, options) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const overrideExisting = Boolean(
        options === true ||
        options && options.overrideExisting === true
    );

    const fileContents = fs.readFileSync(filePath, "utf8");
    fileContents
        .split(/\r?\n/)
        .forEach(function (line) {
            const trimmedLine = String(line || "").trim();
            if (!trimmedLine || trimmedLine.startsWith("#")) {
                return;
            }

            const separatorIndex = trimmedLine.indexOf("=");
            if (separatorIndex <= 0) {
                return;
            }

            const key = trimmedLine.slice(0, separatorIndex).trim();
            const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
            const normalizedValue = rawValue.replace(/^['"]|['"]$/g, "");

            if (overrideExisting || !process.env[key]) {
                process.env[key] = normalizedValue;
            }
        });
}

function hasSupabaseConfig() {
    return Boolean(config.supabase.url && config.supabase.serviceRoleKey);
}

function hasRazorpayConfig() {
    return Boolean(config.razorpay.keyId && config.razorpay.keySecret);
}

function hasR2Config() {
    return Boolean(
        config.r2.accessKey &&
        config.r2.secretKey &&
        config.r2.endpoint &&
        config.r2.publicUrl &&
        config.r2.bucketName
    );
}

function getSupabaseConfigurationError() {
    if (!config.supabase.url) {
        return "SUPABASE_URL is missing on the backend.";
    }

    if (!config.supabase.serviceRoleKey) {
        return "SUPABASE_SERVICE_ROLE_KEY is missing on the backend.";
    }

    return "";
}

function getRazorpayConfigurationError() {
    if (!config.razorpay.keyId) {
        return "RAZORPAY_KEY_ID is missing on the backend.";
    }

    if (!config.razorpay.keySecret) {
        return "RAZORPAY_KEY_SECRET is missing on the backend.";
    }

    return "";
}

function getPhotoRoomConfigurationError() {
    if (!config.photoRoom.apiKey) {
        return "PHOTOROOM_API_KEY is missing on the backend.";
    }

    return "";
}

function getHfRemoveBgConfigurationError() {
    if (!config.hfRemoveBg.spaceId) {
        return "HF_REMOVE_BG_SPACE_ID is missing on the backend.";
    }

    if (!config.hfRemoveBg.apiName) {
        return "HF_REMOVE_BG_API_NAME is missing on the backend.";
    }

    return "";
}

function getR2ConfigurationError() {
    if (!config.r2.accessKey) {
        return "R2_ACCESS_KEY is missing on the backend.";
    }

    if (!config.r2.secretKey) {
        return "R2_SECRET_KEY is missing on the backend.";
    }

    if (!config.r2.endpoint) {
        return "R2_ENDPOINT is missing on the backend.";
    }

    if (!config.r2.publicUrl) {
        return "R2_PUBLIC_URL is missing on the backend.";
    }

    if (!config.r2.bucketName) {
        return "R2 bucket name is missing. Add R2_BUCKET or R2_BUCKET_NAME to backend/.env.";
    }

    return "";
}

function cleanText(value) {
    return String(value || "").trim();
}

function cleanTableName(value) {
    const normalized = cleanText(value);
    return /^[a-zA-Z0-9_]+$/.test(normalized) ? normalized : "";
}

function normalizePositiveNumber(value, fallbackValue) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function buildPremiumPlans() {
    return {
        starter_149_15d: {
            id: "starter_149_15d",
            name: "Starter Plan",
            amountInRupees: 149,
            durationDays: 15,
            monthlyDownloadLimit: 10,
            dailyAiLimit: 2,
            sourceAccess: "none",
            libraryAccessPercent: 10,
            printLayoutLimit: "very_limited",
            toolsAccess: {
                source_access: "none",
                design_library_access_percent: 10,
                background_remover: "basic",
                image_enhancer: "basic",
                ai_output_quality: "standard",
                image_resizer: "limited",
                image_converter: "limited",
                ai_design_generator_limit: 2,
                print_layout_pro: "very_limited",
                processing_speed: "normal",
                watermark: false
            }
        },
        basic_299_3m: {
            id: "basic_299_3m",
            name: "Basic Plan",
            amountInRupees: 299,
            durationDays: 90,
            monthlyDownloadLimit: 30,
            dailyAiLimit: 5,
            sourceAccess: "none",
            libraryAccessPercent: 30,
            printLayoutLimit: "limited_templates",
            toolsAccess: {
                source_access: "none",
                design_library_access_percent: 30,
                background_remover: "basic",
                image_enhancer: "basic",
                ai_output_quality: "standard",
                image_resizer: "limited",
                image_converter: "limited",
                ai_design_generator_limit: 5,
                print_layout_pro: "limited_templates",
                processing_speed: "normal",
                watermark: false
            }
        },
        advanced_599_6m: {
            id: "advanced_599_6m",
            name: "Advanced Plan",
            amountInRupees: 599,
            durationDays: 180,
            monthlyDownloadLimit: 100,
            dailyAiLimit: 20,
            sourceAccess: "partial",
            libraryAccessPercent: 70,
            printLayoutLimit: "auto_layout_hd_export",
            toolsAccess: {
                source_access: "partial",
                design_library_access_percent: 70,
                background_remover: "high_quality",
                image_enhancer: "hd",
                ai_output_quality: "hd",
                image_resizer: "full",
                image_converter: "full",
                ai_design_generator_limit: 20,
                print_layout_pro: "auto_layout_hd_export",
                processing_speed: "fast",
                watermark: false
            }
        },
        ultimate_999_1y: {
            id: "ultimate_999_1y",
            name: "Ultimate Plan",
            amountInRupees: 999,
            durationDays: 365,
            monthlyDownloadLimit: -1,
            dailyAiLimit: -1,
            sourceAccess: "full",
            libraryAccessPercent: 100,
            printLayoutLimit: "full_control_4k_export",
            toolsAccess: {
                source_access: "full",
                design_library_access_percent: 100,
                background_remover: "ultra_ai",
                image_enhancer: "4k",
                ai_output_quality: "4k",
                image_resizer: "full",
                image_converter: "full",
                ai_design_generator_limit: -1,
                print_layout_pro: "full_control_4k_export",
                processing_speed: "super_fast",
                watermark: false
            }
        }
    };
}

function maskCredential(value) {
    const normalized = cleanText(value);
    if (!normalized) {
        return "(missing)";
    }

    if (normalized.length <= 8) {
        return `${normalized.slice(0, 2)}***`;
    }

    return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function ensureTrailingSeparator(value) {
    return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(cleanText(value));
}

function inferBucketNameFromUrl(value) {
    const normalized = cleanText(value);
    if (!normalized) {
        return "";
    }

    try {
        const parsed = new URL(normalized);
        const pathParts = parsed.pathname.split("/").filter(Boolean);
        return cleanTableName(pathParts[0]);
    } catch (_error) {
        return "";
    }
}

module.exports = {
    config,
    cleanText,
    cleanTableName,
    ensureTrailingSeparator,
    getR2ConfigurationError,
    getRazorpayConfigurationError,
    getPhotoRoomConfigurationError,
    getHfRemoveBgConfigurationError,
    getSupabaseConfigurationError,
    hasR2Config,
    hasRazorpayConfig,
    hasSupabaseConfig,
    inferBucketNameFromUrl,
    isHttpUrl,
    maskCredential
};
