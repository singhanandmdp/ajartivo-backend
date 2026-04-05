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
        maxFileSizeBytes: normalizePositiveNumber(process.env.UPLOAD_MAX_FILE_SIZE_MB, 50) * 1024 * 1024,
        maxPreviewSizeBytes: normalizePositiveNumber(process.env.UPLOAD_MAX_PREVIEW_SIZE_MB, 10) * 1024 * 1024
    },
    limits: {
        freeLifetimeDownloads: 5,
        premiumWeeklyDownloads: 2,
        premiumDurationDays: 30
    },
    premiumPlan: {
        name: cleanText(process.env.PREMIUM_PLAN_NAME) || "AJartivo Premium",
        amountInRupees: normalizePositiveNumber(process.env.PREMIUM_PLAN_PRICE, 999)
    }
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

    return Array.from(new Set(configuredTables.concat(defaults))).filter(Boolean);
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
    getSupabaseConfigurationError,
    hasR2Config,
    hasRazorpayConfig,
    hasSupabaseConfig,
    inferBucketNameFromUrl,
    isHttpUrl,
    maskCredential
};
