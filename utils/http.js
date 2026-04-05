const { cleanText, config, maskCredential } = require("../config");

function createHttpError(status, message, meta) {
    const error = new Error(message);
    error.status = status;

    if (typeof meta !== "undefined") {
        error.meta = meta;
    }

    return error;
}

function asyncHandler(handler) {
    return function (req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function notFoundHandler(_req, res) {
    res.status(404).json({ error: "Route not found." });
}

function errorHandler(error, _req, res, _next) {
    const message = cleanText(error && error.message) || "Server request failed.";
    const status = Number(error && (error.status || error.statusCode)) || 500;
    const resolvedStatus = status >= 400 && status < 600 ? status : 500;

    console.error("[AJartivo Backend]", {
        message: message,
        status: resolvedStatus,
        code: cleanText(error && error.code),
        details: error && error.details ? error.details : null,
        meta: error && error.meta ? error.meta : null,
        razorpayKeyId: maskCredential(config.razorpay.keyId),
        supabaseUrl: cleanText(config.supabase.url),
        stack: cleanText(error && error.stack)
    });

    res.status(resolvedStatus).json({ error: message });
}

module.exports = {
    asyncHandler,
    createHttpError,
    errorHandler,
    notFoundHandler
};
